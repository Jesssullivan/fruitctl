import Foundation

extension ClaudeKVMDaemon {

    // MARK: - Command Loop

    func runCommandLoop(vnc: VNCBridge, input: InputController, scaling: DisplayScaling) async {
        let stdin = FileHandle.standardInput
        let lifetime = NativeCommandLifetime()
        input.inputPermit.setFailureHandler { lifetime.cancelCurrent() }

        // Parse on the reader rather than after an action completes. Only the
        // two private permit controls bypass the ordinary serial command lane.
        let requests = AsyncStream<PCRequest> { continuation in
            DispatchQueue.global(qos: .userInteractive).async {
                var buffer = Data()
                var discardOversizedLine = false
                let maximumRequestBytes = 8 * 1024 * 1024
                while true {
                    let data = stdin.availableData
                    if data.isEmpty {
                        input.inputPermit.invalidate()
                        lifetime.close()
                        continuation.finish()
                        return
                    }
                    if discardOversizedLine {
                        guard let newline = data.firstIndex(of: UInt8(ascii: "\n")) else { continue }
                        buffer.append(data[data.index(after: newline)...])
                        discardOversizedLine = false
                    } else { buffer.append(data) }
                    while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                        let line = buffer[buffer.startIndex..<newline]
                        buffer = Data(buffer[buffer.index(after: newline)...])
                        guard !line.isEmpty else { continue }
                        guard line.count <= maximumRequestBytes else {
                            input.inputPermit.invalidateIfRequired()
                            respond(.error(id: nil, code: -32600, message: "Native request exceeds 8 MiB"))
                            continue
                        }
                        do {
                            let request = try JSONDecoder().decode(PCRequest.self, from: line)
                            if PCRequest.inputPermitMethods.contains(request.method) {
                                Task { await handleInputPermit(request, vnc: vnc, permit: input.inputPermit) }
                            } else { continuation.yield(request) }
                        } catch {
                            input.inputPermit.invalidateIfRequired()
                            respond(.error(id: nil, code: -32700, message: "Parse error: \(error.localizedDescription)"))
                        }
                    }
                    if buffer.count > maximumRequestBytes {
                        input.inputPermit.invalidateIfRequired()
                        buffer.removeAll(keepingCapacity: false)
                        discardOversizedLine = true
                        respond(.error(id: nil, code: -32600, message: "Native request exceeds 8 MiB"))
                    }
                }
            }
        }

        for await request in requests {
            let task = Task { await handleRequest(request, vnc: vnc, input: input, scaling: scaling) }
            lifetime.register(task)
            await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
            lifetime.finished()
        }

        log("stdin closed — shutting down")
        await input.releaseHeldInput()
        input.inputPermit.stopWatchdog()
    }

    /// Controls only change the locked permit, never concurrent cursor/held
    /// state or display scaling. Ordinary input remains strictly serialized.
    private func handleInputPermit(_ req: PCRequest, vnc: VNCBridge, permit: NativeInputPermit) async {
        do {
            let p = req.params
            // Bound integers before DisplayScaling converts them through Double.
            guard let width = p?.nativeWidth, let height = p?.nativeHeight,
                  let scaledWidth = p?.scaledWidth, let scaledHeight = p?.scaledHeight,
                  [width, height, scaledWidth, scaledHeight].allSatisfy({ (1...65535).contains($0) }) else {
                throw CommandValidationError.invalid("native input permit geometry")
            }
            let maximum = max(scaledWidth, scaledHeight)
            let binding = try req.inputPermitBinding(scaling: DisplayScaling(
                nativeWidth: width, nativeHeight: height, maxDimension: maximum))
            guard let sequence = p?.sequence else {
                throw CommandValidationError.invalid("native input permit sequence")
            }
            _ = try await vnc.validateExternalObservation(binding.context)
            let receipt: NativeInputPermit.Receipt
            if req.method == "begin_input_permit" {
                receipt = try permit.begin(binding: binding, sequence: sequence)
            } else {
                guard let challenge = p?.challenge, let remaining = p?.leaseRemainingMilliseconds else {
                    throw CommandValidationError.invalid("native input permit grant")
                }
                receipt = try permit.grant(binding: binding, sequence: sequence,
                    challenge: challenge, leaseRemainingMilliseconds: remaining)
            }
            respond(.inputPermit(id: req.id, receipt: receipt))
        } catch {
            permit.invalidate()
            respond(.error(id: req.id, message: error.localizedDescription))
        }
    }

    // MARK: - Request Handler

    func handleRequest(
        _ req: PCRequest,
        vnc: VNCBridge,
        input: InputController,
        scaling: DisplayScaling
    ) async {
        let id = req.id
        let p = req.params
        let receivedMs = Self.monotonicMilliseconds()

        // The private deadline_ms budget (stamped by the Node executor) bounds
        // the input settle wait and caps each fresh-capture deadline, so both
        // fail typed before the executor's own tool deadline fires.
        input.requestDeadlineNs = p?.deadlineMs.map {
            input.inputSettle.now() &+ UInt64(max(0, $0)) * 1_000_000
        }
        defer { input.requestDeadlineNs = nil }

        do {
            try Task.checkCancellation()
            // D27: a mouse hold lives only inside the action_queue batch that
            // opened it. Any request from outside that batch force-releases it.
            if let scope = input.holdScope, p?.holdScope != scope {
                guard await input.releaseHeldInput() else {
                    throw VNCError.sendFailed("Batch-scoped mouse hold release could not be confirmed")
                }
            }
            if req.method == "adopt_observation" { input.context = nil }
            try req.validate(scaling: scaling)
            if PCRequest.inputMethods.contains(req.method) {
                try input.checkInputAdmission()
                // Only this batch's own live hold may remain pressed here.
                guard input.heldKeys.isEmpty, !input.heldButtons || input.holdScope != nil else {
                    throw VNCError.sendFailed("Previous input release is unconfirmed; reconcile the target before continuing")
                }
                guard let context = input.context,
                      context == VNCInputContext(vnc.framebufferDiagnostics) else {
                    throw VNCError.sendFailed("Observed display changed; take a new screenshot before input")
                }
            }
            // Screen observations require newly received full pixel coverage,
            // then encode an owned copy bound to the admitted generation.
            // Image-less checks may keep this authorization, never widen it.
            let priorContext = input.context
            let capturedFrame: VNCBridge.FrameCapture?
            switch req.method {
            case "screenshot", "cursor_crop", "diff_check", "set_baseline", "detect_elements",
                 "zoom", "wait_for_stable", "expect_baseline", "expect_change":
                // Revoke the prior observation before a refresh can fail.
                input.context = nil
                // Every capture-path failure leaves as a typed stale_screen.
                capturedFrame = try await vnc.captureFreshObservation(deadlineNs: input.requestDeadlineNs)
            default: capturedFrame = nil
            }
            if let frame = capturedFrame { admitFreshFrame(frame, input: input, scaling: scaling) }
            switch req.method {

            // ── Screen ────────────────────────────────────────

            case "screenshot":
                guard let imageData = capturedFrame?.withFramebuffer({ buf, w, h -> Data? in
                    createPNGFromRGBA(buffer: buf, width: w, height: h, scaling: scaling)
                }) ?? nil else {
                    throw VNCError.sendFailed("No framebuffer")
                }
                input.context = capturedFrame?.inputContext
                respond(.success(id: id, image: imageData.base64EncodedString(),
                                  scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight,
                                  frameContext: capturedFrame?.inputContext, provenance: capturedFrame?.provenance))

            case "cursor_crop":
                let pos = input.cursorPosition
                let scaledPos = scaling.toScaled(x: pos.x, y: pos.y)
                guard let imageData = capturedFrame?.withFramebuffer({ buf, w, h -> Data? in
                    cropWithCrosshair(buffer: buf, width: w, height: h,
                                      centerX: pos.x, centerY: pos.y, radius: input.timing.cursorCropRadius)
                }) ?? nil else {
                    throw VNCError.sendFailed("No framebuffer")
                }
                input.context = capturedFrame?.inputContext
                respond(.success(id: id, image: imageData.base64EncodedString(),
                                  x: scaledPos.x, y: scaledPos.y,
                                  frameContext: capturedFrame?.inputContext, provenance: capturedFrame?.provenance))

            case "zoom":
                guard let frame = capturedFrame, let rect = p?.rect else { throw VNCError.sendFailed("No framebuffer") }
                // Validation used the pre-capture mapping; clamp to the fresh frame's.
                let display = FrameRect(x: 0, y: 0, width: scaling.scaledWidth, height: scaling.scaledHeight)
                guard let region = rect.intersection(display),
                      let native = FrameRegion.toNative(region, nativeWidth: frame.width, nativeHeight: frame.height,
                                                        scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight),
                      let zoomed = frame.withFramebuffer({ buf, w, h in
                          cropRegionToPNG(buffer: buf, fbWidth: w, fbHeight: h, region: native,
                                          maxDimension: p?.maxDimension ?? Self.zoomMaxDimension)
                      }) else {
                    throw VNCError.sendFailed("Zoom region is unavailable in the current frame")
                }
                input.context = frame.inputContext
                respond(.success(id: id,
                                  detail: "zoom \(region.width)×\(region.height) at (\(region.x), \(region.y)) → "
                                      + "\(zoomed.width)×\(zoomed.height) image",
                                  image: zoomed.png.base64EncodedString(),
                                  scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight,
                                  frameContext: frame.inputContext, provenance: frame.provenance,
                                  zoom: ZoomSummary(region: region, native: native,
                                                    imageWidth: zoomed.width, imageHeight: zoomed.height)))

            case "diff_check":
                guard let frame = capturedFrame else { throw VNCError.sendFailed("No framebuffer") }
                let diff = FrameRegion.evaluate(baseline: Self.framebufferBaseline.snapshot, current: frame.pixels,
                                                context: frame.inputContext, include: p?.regions,
                                                exclude: p?.ignore ?? [], scaledWidth: scaling.scaledWidth,
                                                scaledHeight: scaling.scaledHeight)
                Self.framebufferBaseline.set(frame.pixels, context: frame.inputContext)
                input.context = frame.inputContext
                respond(.success(id: id, detail: "changeDetected: \(diff.changed)", frameContext: frame.inputContext,
                                  provenance: frame.provenance, diff: diff))

            case "wait_for_stable":
                guard var frame = capturedFrame, let stableMs = p?.stableMs, let timeoutMs = p?.timeoutMs else {
                    throw VNCError.sendFailed("No framebuffer")
                }
                // Every comparison is between two fresh frames; nothing cached.
                var stability = FrameStability(stableMilliseconds: stableMs, timeoutMilliseconds: timeoutMs,
                                               startedMilliseconds: receivedMs,
                                               firstCaptureMilliseconds: Self.monotonicMilliseconds())
                let poll = FrameStability.pollMilliseconds(stableMilliseconds: stableMs)
                while !stability.isStable {
                    let now = Self.monotonicMilliseconds()
                    guard !stability.isExpired(atMilliseconds: now) else {
                        throw ObservationUnmetError(reason: .stableTimeout,
                            message: "Screen did not stay unchanged for \(stableMs) ms within \(timeoutMs) ms",
                            elapsedMilliseconds: Int(stability.elapsed(atMilliseconds: now)),
                            captures: stability.captures)
                    }
                    let remaining = stability.timeoutMilliseconds - stability.elapsed(atMilliseconds: now)
                    try await Task.sleep(nanoseconds: min(poll, remaining) * 1_000_000)
                    let next = try await vnc.captureFreshObservation(deadlineNs: input.requestDeadlineNs)
                    admitFreshFrame(next, input: input, scaling: scaling)
                    let diff = FrameRegion.evaluate(baseline: (pixels: frame.pixels, context: frame.inputContext),
                                                    current: next.pixels, context: next.inputContext,
                                                    include: p?.regions, exclude: p?.ignore ?? [],
                                                    scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight)
                    stability.observe(changed: diff.changed, atMilliseconds: Self.monotonicMilliseconds())
                    frame = next
                }
                input.context = Self.retainedAuthorization(priorContext, frame.inputContext)
                let elapsed = Int(stability.elapsed(atMilliseconds: Self.monotonicMilliseconds()))
                respond(.success(id: id,
                                  detail: "stable for \(stability.stableForMilliseconds) ms after \(elapsed) ms",
                                  frameContext: frame.inputContext, provenance: frame.provenance,
                                  stable: StableSummary(stableMilliseconds: stableMs,
                                                        stableForMilliseconds: Int(stability.stableForMilliseconds),
                                                        elapsedMilliseconds: elapsed, captures: stability.captures)))

            // Private action_queue expectation primitives (not vnc_command actions).
            case "expect_baseline":
                guard let frame = capturedFrame else { throw VNCError.sendFailed("No framebuffer") }
                Self.expectationBaseline.set(frame.pixels, context: frame.inputContext)
                input.context = Self.retainedAuthorization(priorContext, frame.inputContext)
                respond(.success(id: id, detail: "OK", frameContext: frame.inputContext, provenance: frame.provenance))

            case "expect_change":
                guard var frame = capturedFrame, let rect = p?.rect else { throw VNCError.sendFailed("No framebuffer") }
                guard let baseline = Self.expectationBaseline.snapshot else {
                    throw CommandValidationError.invalid("expect_change requires a preceding expect_baseline")
                }
                // One step's baseline answers only that step's expectation.
                Self.expectationBaseline.clear()
                let timeout = UInt64(p?.timeoutMs ?? Self.expectChangeTimeoutMs)
                var captures = 1
                while true {
                    let diff = FrameRegion.evaluate(baseline: baseline, current: frame.pixels,
                                                    context: frame.inputContext, include: [rect], exclude: [],
                                                    scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight)
                    if diff.changed {
                        input.context = Self.retainedAuthorization(priorContext, frame.inputContext)
                        respond(.success(id: id, detail: "changeObserved: true", frameContext: frame.inputContext,
                                          provenance: frame.provenance, diff: diff))
                        break
                    }
                    let elapsed = Self.monotonicMilliseconds() - receivedMs
                    guard elapsed < timeout else {
                        throw ObservationUnmetError(reason: .changeNotObserved,
                            message: "No change observed in the expected region within \(timeout) ms",
                            elapsedMilliseconds: Int(elapsed), captures: captures)
                    }
                    try await Task.sleep(nanoseconds: min(Self.expectChangePollMs, timeout - elapsed) * 1_000_000)
                    frame = try await vnc.captureFreshObservation(deadlineNs: input.requestDeadlineNs)
                    admitFreshFrame(frame, input: input, scaling: scaling)
                    captures += 1
                }

            case "set_baseline":
                guard let frame = capturedFrame else { throw VNCError.sendFailed("No framebuffer") }
                Self.framebufferBaseline.set(frame.pixels, context: frame.inputContext)
                input.context = frame.inputContext
                respond(.success(id: id, detail: "OK", frameContext: frame.inputContext, provenance: frame.provenance))

            // ── Mouse ─────────────────────────────────────────

            case "mouse_move":
                let native = nativeXY(p, scaling: scaling)
                try await input.mouseMove(x: native.x, y: native.y)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "hover":
                let native = nativeXY(p, scaling: scaling)
                try await input.mouseHover(x: native.x, y: native.y)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "nudge":
                guard let dx = p?.dx, let dy = p?.dy else {
                    throw VNCError.sendFailed("Missing dx/dy")
                }
                let nativeDX = Int((Double(dx) * Double(scaling.nativeWidth) / Double(scaling.scaledWidth)).rounded())
                let nativeDY = Int((Double(dy) * Double(scaling.nativeHeight) / Double(scaling.scaledHeight)).rounded())
                try await input.mouseNudge(dx: nativeDX, dy: nativeDY)
                try input.checkInputAdmission()
                let pos = scaling.toScaled(x: input.cursorPosition.x, y: input.cursorPosition.y)
                respond(.success(id: id, detail: "OK", x: pos.x, y: pos.y))

            case "mouse_click":
                let native = nativeXY(p, scaling: scaling)
                let btn = parseButton(p?.button)
                let modifiers = (p?.modifiers ?? []).compactMap(modifierNameToKeysym)
                try await input.mouseClick(x: native.x, y: native.y, button: btn, modifiers: modifiers)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "triple_click":
                let native = nativeXY(p, scaling: scaling)
                try await input.mouseTripleClick(x: native.x, y: native.y)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "mouse_down":
                guard let scope = p?.holdScope else { throw NativeInputRefusal.holdOutsideBatch }
                let native = nativeXY(p, scaling: scaling)
                try await input.mouseDown(x: native.x, y: native.y, button: parseButton(p?.button), scope: scope)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "mouse_up":
                guard p?.holdScope != nil else { throw NativeInputRefusal.holdOutsideBatch }
                let point = p?.x.map { _ in nativeXY(p, scaling: scaling) }
                try await input.mouseUp(x: point?.x, y: point?.y, button: parseButton(p?.button))
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "mouse_double_click":
                let native = nativeXY(p, scaling: scaling)
                try await input.mouseDoubleClick(x: native.x, y: native.y)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "mouse_drag":
                guard let toX = p?.toX, let toY = p?.toY else {
                    throw VNCError.sendFailed("Missing toX/toY")
                }
                let from = nativeXY(p, scaling: scaling)
                let to = scaling.toNative(x: toX, y: toY)
                try await input.mouseDrag(fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
                                          button: parseButton(p?.button))
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "scroll":
                let native = nativeXY(p, scaling: scaling)
                guard let dirStr = p?.direction,
                      let dir = ScrollDirection(rawValue: dirStr) else {
                    throw VNCError.sendFailed("Missing direction")
                }
                try await input.scroll(x: native.x, y: native.y, direction: dir, amount: p?.amount ?? 3)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            // ── Keyboard ──────────────────────────────────────

            case "key_tap":
                guard let keyName = p?.key, let sym = namedKeyToKeysym(keyName) else {
                    throw VNCError.sendFailed("Missing or unknown key")
                }
                try await input.keyTap(sym)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "hold_key":
                guard let keyName = p?.key, let sym = namedKeyToKeysym(keyName), let ms = p?.durationMs else {
                    throw VNCError.sendFailed("Missing or unknown key/duration_ms")
                }
                try await input.holdKey(sym, durationUs: UInt32(ms) * 1000)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "key_combo":
                if let combo = p?.key {
                    try await input.keyCombo(combo)
                } else if let keys = p?.keys {
                    let syms = keys.compactMap { namedKeyToKeysym($0) }
                    guard syms.count == keys.count else {
                        throw VNCError.sendFailed("Unknown key in combo: \(keys)")
                    }
                    try await input.keyCombo(syms)
                } else {
                    throw VNCError.sendFailed("Missing key or keys")
                }
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "key_type":
                guard let text = p?.text else {
                    throw VNCError.sendFailed("Missing text")
                }
                try await input.typeText(text)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "paste":
                guard let text = p?.text else {
                    throw VNCError.sendFailed("Missing text")
                }
                try await input.pasteText(text)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "type_secret":
                guard let secret = p?.secret else { throw SecretTypingError.invalidLength }
                let focus: (x: Int, y: Int)? = p?.x != nil && p?.y != nil ? nativeXY(p, scaling: scaling) : nil
                try await input.typeSecret(secret, focusAt: focus)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            // ── Cursor ────────────────────────────────────────

            case "cursor_position":
                // fruitctl's own record of the last pointer position it wrote,
                // in scaled space. It is not read back from the server cursor.
                let pos = scaling.toScaled(x: input.cursorPosition.x, y: input.cursorPosition.y)
                respond(.success(id: id, detail: "tracked (\(pos.x), \(pos.y)); not the server cursor",
                                  x: pos.x, y: pos.y))

            // ── Detection ──────────────────────────────────────

            case "detect_elements":
                guard let elements = capturedFrame?.withFramebuffer({ buf, w, h -> [TextElement] in
                    detectTextElements(buffer: buf, width: w, height: h, scaling: scaling)
                }) else { throw VNCError.sendFailed("No framebuffer") }
                input.context = capturedFrame?.inputContext
                respond(.success(id: id, detail: "\(elements.count) elements",
                                  scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight,
                                  elements: elements, frameContext: capturedFrame?.inputContext,
                                  provenance: capturedFrame?.provenance))

            // ── Configuration ─────────────────────────────────

            case "adopt_observation":
                let expected = try req.externalObservation(scaling: scaling)
                try await input.adoptObservation(expected, scaling: scaling)
                respond(.success(id: id, detail: "OK", scaledWidth: scaling.scaledWidth,
                                  scaledHeight: scaling.scaledHeight, frameContext: expected))

            case "configure":
                input.inputPermit.invalidateIfRequired()
                handleConfigure(id: id, params: p, input: input, scaling: scaling)

            case "get_timing":
                let timing = buildTimingMap(input: input, scaling: scaling)
                respond(.success(id: id,
                                  scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight,
                                  timing: timing))

            // ── Control ───────────────────────────────────────

            case "wait":
                let ms = p?.ms ?? 500
                try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
                respond(.success(id: id, detail: "OK"))

            case "health":
                let current = VNCInputContext(vnc.framebufferDiagnostics)
                let liveScaling = DisplayScaling(nativeWidth: current.width, nativeHeight: current.height,
                                                 maxDimension: scaling.maxDimension)
                // Readiness is reported, never awaited: health is observation.
                respond(PCResponse.success(id: id, detail: "\(vnc.connectionState)",
                                  scaledWidth: liveScaling.scaledWidth, scaledHeight: liveScaling.scaledHeight,
                                  frameContext: current, capabilities: PCRequest.supportedMethods)
                    .withInputSettle(vnc.inputSettle.status()))

            case "release_holds":
                // Batch end (D27): release this batch's live hold, if any.
                let held = input.holdScope != nil
                guard await input.releaseHeldInput() else {
                    throw VNCError.sendFailed("Batch-scoped mouse hold release could not be confirmed")
                }
                respond(.success(id: id, detail: held ? "released" : "none held"))

            case "shutdown":
                input.inputPermit.stopWatchdog()
                guard await input.releaseHeldInput() else {
                    throw VNCError.sendFailed("Shutdown could not confirm held-state release")
                }
                respond(.success(id: id, detail: "OK"))
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { Foundation.exit(0) }
                return

            default:
                respond(.error(id: id, code: -32601, message: "Method not found: \(req.method)"))
            }
        } catch {
            input.inputPermit.invalidateIfRequired()
            await input.releaseHeldInput()
            respond(PCResponse.staleScreen(id: id, error: error)
                    ?? PCResponse.inputRefusal(id: id, error: error)
                    ?? PCResponse.inputNotReady(id: id, error: error)
                    ?? PCResponse.observationUnmet(id: id, error: error)
                    ?? .error(id: id, message: error.localizedDescription))
        }
    }

    // MARK: - Configure Handler

    private func handleConfigure(
        id: PCId?,
        params p: PCRequest.Params?,
        input: InputController,
        scaling: DisplayScaling
    ) {
        if p?.reset == true {
            input.timing = InputTiming()
            scaling.reset()
            let timing = buildTimingMap(input: input, scaling: scaling)
            respond(.success(id: id, detail: "OK — reset to defaults",
                              scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight,
                              timing: timing))
            return
        }

        var changed: [String] = []

        // Display
        if let v = p?.maxDimension {
            scaling.reconfigure(maxDimension: v)
            changed.append("max_dimension")
        }

        // Mouse
        if let v = p?.clickHoldMs {
            input.timing.clickHoldUs = UInt32(v) * 1000
            changed.append("click_hold_ms")
        }
        if let v = p?.doubleClickGapMs {
            input.timing.doubleClickGapUs = UInt32(v) * 1000
            changed.append("double_click_gap_ms")
        }
        if let v = p?.hoverSettleMs {
            input.timing.hoverSettleUs = UInt32(v) * 1000
            changed.append("hover_settle_ms")
        }

        // Drag
        if let v = p?.dragPositionMs {
            input.timing.dragPositionUs = UInt32(v) * 1000
            changed.append("drag_position_ms")
        }
        if let v = p?.dragPressMs {
            input.timing.dragPressUs = UInt32(v) * 1000
            changed.append("drag_press_ms")
        }
        if let v = p?.dragStepMs {
            input.timing.dragStepUs = UInt32(v) * 1000
            changed.append("drag_step_ms")
        }
        if let v = p?.dragSettleMs {
            input.timing.dragSettleUs = UInt32(v) * 1000
            changed.append("drag_settle_ms")
        }
        if let v = p?.dragPixelsPerStep {
            input.timing.dragPixelsPerStep = v
            changed.append("drag_pixels_per_step")
        }
        if let v = p?.dragMinSteps {
            input.timing.dragMinSteps = v
            changed.append("drag_min_steps")
        }

        // Scroll
        if let v = p?.scrollPressMs {
            input.timing.scrollPressUs = UInt32(v) * 1000
            changed.append("scroll_press_ms")
        }
        if let v = p?.scrollTickMs {
            input.timing.scrollTickUs = UInt32(v) * 1000
            changed.append("scroll_tick_ms")
        }

        // Keyboard
        if let v = p?.keyHoldMs {
            input.timing.keyHoldUs = UInt32(v) * 1000
            changed.append("key_hold_ms")
        }
        if let v = p?.comboModMs {
            input.timing.comboModUs = UInt32(v) * 1000
            changed.append("combo_mod_ms")
        }

        // Typing
        if let v = p?.typeKeyMs {
            input.timing.typeKeyUs = UInt32(v) * 1000
            changed.append("type_key_ms")
        }
        if let v = p?.typeInterKeyMs {
            input.timing.typeInterKeyUs = UInt32(v) * 1000
            changed.append("type_inter_key_ms")
        }
        if let v = p?.typeShiftMs {
            input.timing.typeShiftUs = UInt32(v) * 1000
            changed.append("type_shift_ms")
        }
        if let v = p?.pasteSettleMs {
            input.timing.pasteSettleUs = UInt32(v) * 1000
            changed.append("paste_settle_ms")
        }

        // Display tuning
        if let v = p?.cursorCropRadius {
            input.timing.cursorCropRadius = v
            changed.append("cursor_crop_radius")
        }

        if changed.isEmpty {
            respond(.error(id: id, message: "No valid parameters provided"))
            return
        }

        log("configure: \(changed.joined(separator: ", "))")

        if changed.contains("max_dimension") {
            log("Display rescaled: \(scaling.scaledWidth)×\(scaling.scaledHeight)")
            respond(.success(id: id, detail: "OK — changed: \(changed.joined(separator: ", "))",
                              scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight))
        } else {
            respond(.success(id: id, detail: "OK — changed: \(changed.joined(separator: ", "))"))
        }
    }

    // MARK: - Timing Map Builder

    private func buildTimingMap(input: InputController, scaling: DisplayScaling) -> [String: Double] {
        let t = input.timing
        return [
            "max_dimension": Double(scaling.maxDimension),
            "click_hold_ms": Double(t.clickHoldUs) / 1000,
            "double_click_gap_ms": Double(t.doubleClickGapUs) / 1000,
            "hover_settle_ms": Double(t.hoverSettleUs) / 1000,
            "drag_position_ms": Double(t.dragPositionUs) / 1000,
            "drag_press_ms": Double(t.dragPressUs) / 1000,
            "drag_step_ms": Double(t.dragStepUs) / 1000,
            "drag_settle_ms": Double(t.dragSettleUs) / 1000,
            "drag_pixels_per_step": t.dragPixelsPerStep,
            "drag_min_steps": Double(t.dragMinSteps),
            "scroll_press_ms": Double(t.scrollPressUs) / 1000,
            "scroll_tick_ms": Double(t.scrollTickUs) / 1000,
            "key_hold_ms": Double(t.keyHoldUs) / 1000,
            "combo_mod_ms": Double(t.comboModUs) / 1000,
            "type_key_ms": Double(t.typeKeyUs) / 1000,
            "type_inter_key_ms": Double(t.typeInterKeyUs) / 1000,
            "type_shift_ms": Double(t.typeShiftUs) / 1000,
            "paste_settle_ms": Double(t.pasteSettleUs) / 1000,
            "cursor_crop_radius": Double(t.cursorCropRadius),
        ]
    }

    // MARK: - Helpers

    static let zoomMaxDimension = 1280
    static let expectChangeTimeoutMs = 3000
    static let expectChangePollMs: UInt64 = 100

    static func monotonicMilliseconds() -> UInt64 { DispatchTime.now().uptimeNanoseconds / 1_000_000 }

    /// wait_for_stable and the queue expectation primitives return no image,
    /// so the caller never saw their frame. They keep the request's prior
    /// input authorization only while the display identity is unchanged, and
    /// never grant one: a changed display still needs a new screenshot.
    static func retainedAuthorization(_ prior: VNCInputContext?, _ current: VNCInputContext) -> VNCInputContext? {
        prior == current ? prior : nil
    }

    /// Every fresh frame refreshes the mapping before use. Nothing authorizes
    /// input until a handler adopts the frame that it actually encoded.
    private func admitFreshFrame(_ frame: VNCBridge.FrameCapture, input: InputController, scaling: DisplayScaling) {
        scaling.updateGeometry(width: frame.width, height: frame.height)
        input.context = nil
        input.cursorX = min(max(0, input.cursorX), frame.width - 1)
        input.cursorY = min(max(0, input.cursorY), frame.height - 1)
    }

    func nativeXY(_ params: PCRequest.Params?, scaling: DisplayScaling) -> (x: Int, y: Int) {
        let x = params?.x ?? 0
        let y = params?.y ?? 0
        return scaling.toNative(x: x, y: y)
    }

    func parseButton(_ name: String?) -> MouseButton {
        switch name?.lowercased() {
        case "right":  return .right
        case "middle": return .middle
        default:       return .left
        }
    }
}

/// EOF can arrive while the serial loop is inside a long input operation.
/// Cancel that operation immediately rather than waiting for its next request.
private final class NativeCommandLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var closed = false
    private var task: Task<Void, Never>?

    func register(_ task: Task<Void, Never>) {
        lock.lock()
        self.task = task
        let shouldCancel = closed
        lock.unlock()
        if shouldCancel { task.cancel() }
    }

    func finished() {
        lock.lock(); task = nil; lock.unlock()
    }

    func close() {
        lock.lock()
        closed = true
        let current = task
        lock.unlock()
        current?.cancel()
    }

    func cancelCurrent() {
        lock.lock(); let current = task; lock.unlock()
        current?.cancel()
    }
}
