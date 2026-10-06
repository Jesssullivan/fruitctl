import AppKit
import CoreGraphics
import Darwin

struct HostOptions {
    var captureChoice: Bool?
    var displayID: CGDirectDisplayID?
    var requestPermission = false
    var mode: Mode = .application
    enum Mode { case application, stdio, doctor, help }

    static func parse(_ arguments: [String]) throws -> HostOptions {
        var options = HostOptions()
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--help", "-h": options.mode = .help
            case "--stdio":
                guard options.mode == .application else { throw HostLeaseError.invalidParameters }
                options.mode = .stdio
            case "--doctor":
                guard options.mode == .application else { throw HostLeaseError.invalidParameters }
                options.mode = .doctor
            case "--enable-capture", "--disable-capture":
                guard options.captureChoice == nil else { throw HostLeaseError.invalidParameters }
                options.captureChoice = arguments[index] == "--enable-capture"
            case "--request-screen-capture": options.requestPermission = true
            case "--display-id":
                index += 1
                guard index < arguments.count, let id = UInt32(arguments[index]), id > 0 else {
                    throw HostLeaseError.invalidParameters
                }
                options.displayID = id
            default: throw HostLeaseError.invalidParameters
            }
            index += 1
        }
        guard options.mode == .application || (options.captureChoice == nil && !options.requestPermission),
              !options.requestPermission || options.captureChoice == true else {
            throw HostLeaseError.invalidParameters
        }
        return options
    }
}

@MainActor
final class HostApplicationController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let options: HostOptions
    private let clock = HostClock()
    private let renderer = HostRenderer()
    private let capture: HostCapture
    private let capturePreferences: HostCapturePreferences
    private let permission: HostCapturePermission
    private let instanceID = UUID().uuidString
    private var lease = HostLeaseState()
    private var availability = HostAvailabilityState()
    private var generation: UInt64 = 1
    private var captureReady = false
    private var overlayReady = false
    private var lastUIHeartbeat: UInt64?
    private var captureInProgress = false
    private var timer: Timer?
    private var notifications: [NSObjectProtocol] = []
    private var signalSources: [DispatchSourceSignal] = []
    private var server: HostSocketServer?
    private var statusItem: NSStatusItem?
    private var stopMenuItem: NSMenuItem?
    private var allowMenuItem: NSMenuItem?
    private var enableCaptureMenuItem: NSMenuItem?
    private var disableCaptureMenuItem: NSMenuItem?
    private var idleReferenceMenuItem: NSMenuItem?
    private lazy var idleReference = HostIdleReferenceCoordinator(
        permission: permission, clock: { [weak self] in self?.clock.milliseconds() ?? UInt64.max },
        conditions: { [unowned self] in self.idleReferenceConditions },
        capture: { [weak self] in
            guard let self else { throw HostIdleReferenceError.lifecycleChanged }
            // Native source axes are bounded at 16,384 by the shared capture
            // path. This internal size requests ratio1 without exposing a new
            // unbounded max_dimension to ordinary IPC observations.
            let image = try await self.capture.snapshot(maximumDimension: 16_384)
            return HostReferenceCapture(png: image.png, metadata: image.geometryMetadata)
        }, connectionLive: { [weak self] connection in
            self?.server?.connectionIsLive(connection) == true
        }, persist: { image, receipt in
            try HostReferenceStore(root: HostReferenceStore.defaultRoot).save(image, receipt: receipt)
        })

    init(options: HostOptions) {
        self.options = options
        let preferences = HostCapturePreferences(startupChoice: options.captureChoice)
        capturePreferences = preferences
        let authorization = HostCapturePermission.system()
        permission = authorization
        capture = HostCapture(preferences: preferences, permission: authorization,
                              displayID: options.displayID ?? CGMainDisplayID())
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        installHumanControl()
        renderer.rebuild()
        if options.requestPermission && !permission.isGranted {
            // This flag is an explicit, attended opt-in. Stdio/doctor never ask.
            _ = permission.requestFromHuman()
            updateHumanControl()
        }
        let endpoint = HostSocketServer(handler: { [weak self] request, connection, reply in
            Task { @MainActor in
                guard let self else {
                    reply(.failure(id: request.id, message: "helper_stopping")); return
                }
                reply(await self.handle(request, connectionID: connection))
            }
        }, disconnected: { [weak self] connection in
            Task { @MainActor in self?.disconnected(connection) }
        })
        do { try endpoint.start(); server = endpoint }
        catch {
            Self.writeError("FruitctlHost: private IPC unavailable; no activity can start.\n")
            NSApplication.shared.terminate(nil)
            return
        }
        timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            // Timer fires on the main run loop, so it cannot certify a stuck UI.
            MainActor.assumeIsolated { self?.tick() }
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
        observeDisplayAndSession()
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { NSApplication.shared.terminate(nil) }
            source.resume(); signalSources.append(source)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        invalidateActivity()
        server?.stop(); server = nil
        for observer in notifications {
            NotificationCenter.default.removeObserver(observer)
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        notifications.removeAll()
        for source in signalSources { source.cancel() }
        signalSources.removeAll()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
    }

    private func installHumanControl() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "Fruitctl"
        item.button?.toolTip = "Fruitctl agent control"
        item.button?.setAccessibilityLabel("Fruitctl agent control")
        let menu = NSMenu(title: "Fruitctl agent control")
        menu.autoenablesItems = false
        menu.delegate = self
        let stop = NSMenuItem(title: "Stop agent control", action: #selector(stopAgentControl(_:)),
                              keyEquivalent: "")
        stop.target = self
        let allow = NSMenuItem(title: "Allow agent control", action: #selector(allowAgentControl(_:)),
                               keyEquivalent: "")
        allow.target = self
        let quit = NSMenuItem(title: "Quit Fruitctl Host", action: #selector(quitHost(_:)),
                              keyEquivalent: "")
        quit.target = self
        let enable = NSMenuItem(title: "Enable capture", action: #selector(enableCapture(_:)),
                                keyEquivalent: "")
        enable.target = self
        let disable = NSMenuItem(title: "Disable capture", action: #selector(disableCapture(_:)),
                                 keyEquivalent: "")
        disable.target = self
        let reference = NSMenuItem(title: "Arm one idle reference export (60s)",
                                   action: #selector(armIdleReference(_:)), keyEquivalent: "")
        reference.target = self
        menu.addItem(stop); menu.addItem(allow); menu.addItem(.separator())
        menu.addItem(enable); menu.addItem(disable); menu.addItem(reference)
        menu.addItem(.separator()); menu.addItem(quit)
        item.menu = menu
        statusItem = item; stopMenuItem = stop; allowMenuItem = allow
        enableCaptureMenuItem = enable; disableCaptureMenuItem = disable
        idleReferenceMenuItem = reference
        updateHumanControl()
    }

    private func updateHumanControl() {
        stopMenuItem?.isEnabled = availability.humanAllowed
        allowMenuItem?.isEnabled = !availability.humanAllowed
        enableCaptureMenuItem?.isEnabled = !capturePreferences.isEnabled
        disableCaptureMenuItem?.isEnabled = capturePreferences.isEnabled
        idleReferenceMenuItem?.isEnabled = capturePreferences.isEnabled && permission.isGranted
            && idleReferenceConditions.isIdle && !idleReference.isExporting
        statusItem?.button?.title = availability.humanAllowed ? "Fruitctl" : "Fruitctl · Stopped"
    }

    func menuWillOpen(_ menu: NSMenu) { updateHumanControl() }

    @objc private func stopAgentControl(_ sender: Any?) {
        availability.apply(.humanStopped)
        invalidateActivity()
        updateHumanControl()
    }

    @objc private func allowAgentControl(_ sender: Any?) {
        availability.apply(.humanResumed)
        // Allowing creates no lease and bypasses none of the session/display
        // checks. A controller must start an entirely new activity.
        invalidateActivity()
        updateHumanControl()
    }

    @objc private func quitHost(_ sender: Any?) {
        stopAgentControl(sender)
        NSApplication.shared.terminate(nil)
    }

    @objc private func enableCapture(_ sender: Any?) {
        // Persist before asking: macOS Quit & Reopen drops custom launch args.
        capturePreferences.setEnabled(true)
        invalidateActivity()
        updateHumanControl()
        if !permission.isGranted { _ = permission.requestFromHuman() }
        updateHumanControl()
    }

    @objc private func disableCapture(_ sender: Any?) {
        capturePreferences.setEnabled(false)
        invalidateActivity()
        updateHumanControl()
    }

    @objc private func armIdleReference(_ sender: Any?) {
        do {
            _ = try idleReference.armFromHuman()
            statusItem?.button?.toolTip = "One idle reference may be exported within 60 seconds"
        } catch {
            // This diagnostic never requests permission, enables capture,
            // hides panels, or clears the human Stop latch.
            statusItem?.button?.toolTip = "Idle reference unavailable; no capture started"
        }
        updateHumanControl()
    }

    private func observeDisplayAndSession() {
        notifications.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.generation &+= 1
                self.invalidateActivity()
                self.renderer.rebuild()
            }
        })
        let workspace = NSWorkspace.shared.notificationCenter
        let transitions: [(Notification.Name, HostAvailabilityState.Event)] = [
            (NSWorkspace.sessionDidResignActiveNotification, .sessionResigned),
            (NSWorkspace.sessionDidBecomeActiveNotification, .sessionActivated),
            (NSWorkspace.screensDidSleepNotification, .screensSlept),
            (NSWorkspace.screensDidWakeNotification, .screensWoke),
            (NSWorkspace.willSleepNotification, .systemSlept),
            (NSWorkspace.didWakeNotification, .systemWoke)
        ]
        for (name, event) in transitions {
            notifications.append(workspace.addObserver(forName: name, object: nil, queue: .main) {
                [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.availability.apply(event)
                    // Every transition requires a fresh activity/capture; wake
                    // never restores an expired lease or an old input permit.
                    self.invalidateActivity()
                }
            })
        }
        notifications.append(workspace.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.renderer.updateMotion() }
        })
    }

    private func tick() {
        let now = clock.milliseconds()
        if lease.expire(at: now) { clearActivityUI() }
        if (lease.active != nil || idleReference.armedID != nil || idleReference.isExporting)
            && (!activityEligible || !capture.enabled || !permission.isGranted) {
            invalidateActivity()
        }
        if lease.active != nil {
            switch HostLeaseState.uiHeartbeatDecision(activityEligible: activityEligible,
                captureInProgress: captureInProgress, captureReady: captureReady,
                overlayReady: overlayReady, visiblePanels: renderer.hasVisibleDisplayPanels) {
            case .awaitingInitialCapture:
                // expire(at:) above still enforces the original 3-second lease.
                // No UI heartbeat or ready permit exists before excluded capture.
                break
            case .recordVisibleHeartbeat: lastUIHeartbeat = now
            case .invalidate: invalidateActivity()
            }
        }
    }

    private var activityEligible: Bool {
        // The inactive-launch notification can precede didFinishLaunching, so
        // notifications alone cannot establish the initial GUI session state.
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        let onConsole = session[kCGSessionOnConsoleKey] as? Bool == true
        let ownedSession = (session[kCGSessionUserIDKey] as? NSNumber)?.uint32Value == getuid()
        let screens = NSScreen.screens
        let drawable = !screens.isEmpty && screens.allSatisfy { screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            else { return false }
            let display = CGDirectDisplayID(number.uint32Value)
            return CGDisplayIsActive(display) != 0 && CGDisplayIsAsleep(display) == 0
        } && CGDisplayIsActive(capture.displayID) != 0 && CGDisplayIsAsleep(capture.displayID) == 0
        return availability.allowsActivity(onConsole: onConsole, ownedSession: ownedSession,
                                            displaysDrawable: drawable)
    }

    private var idleReferenceConditions: HostIdleReferenceConditions {
        HostIdleReferenceConditions(captureEnabled: capture.enabled, activityEligible: activityEligible,
            activeLease: lease.active != nil, captureReady: captureReady, overlayReady: overlayReady,
            anyVisiblePanel: renderer.hasAnyVisiblePanels, otherCaptureInProgress: captureInProgress,
            lifecycleRevision: availability.revision, displayGeneration: generation)
    }

    private func requireAvailable() throws {
        guard activityEligible else { invalidateActivity(); throw HostLeaseError.notReady }
    }

    private func disconnected(_ connectionID: UUID) {
        idleReference.disconnected(connectionID)
        if lease.release(connectionID: connectionID) { clearActivityUI() }
    }

    private func invalidateActivity() {
        idleReference.invalidate()
        lease.invalidate(); clearActivityUI()
    }

    private func clearActivityUI() {
        renderer.hide()
        captureReady = false; overlayReady = false; lastUIHeartbeat = nil
    }

    private func validateDisplay(_ request: HostRequest) throws {
        if let display = request.params["display_id"] {
            guard display.unsigned == UInt64(capture.displayID) else {
                throw HostCaptureError.displayUnavailable
            }
        }
        if let mode = request.params["capture_backend"] {
            guard mode.string == "owned_sck" else { throw HostLeaseError.invalidParameters }
        }
    }

    private func maximumDimension(_ request: HostRequest) throws -> Int {
        guard let value = request.params["max_dimension"] else { return 1_280 }
        guard let size = value.integer, (256...4_096).contains(size) else {
            throw HostLeaseError.invalidParameters
        }
        return size
    }

    private func readiness(now: UInt64, activity: HostActivityLease? = nil) -> [String: HostValue] {
        let age = HostLeaseState.heartbeatAge(now: now, uiHeartbeatAt: lastUIHeartbeat)
        let current = activity ?? lease.active
        var result: [String: HostValue] = [
            "instance_id": .string(instanceID), "capture_backend": .string("owned_sck"),
            "capture_enabled": .boolean(capture.enabled), "capture_ready": .boolean(captureReady),
            "overlay_ready": .boolean(overlayReady && renderer.hasVisibleDisplayPanels),
            "activity_eligible": .boolean(activityEligible),
            "human_stop_latched": .boolean(!availability.humanAllowed),
            "ready": .boolean(current != nil && activityEligible && HostLeaseState.isReady(now: now,
                uiHeartbeatAt: lastUIHeartbeat, captureReady: captureReady,
                overlayReady: overlayReady && renderer.hasVisibleDisplayPanels)),
            "raw_vnc_exclusion": .boolean(false), "display_id": .integer(Int64(capture.displayID)),
            "displayGeneration": .integer(Int64(clamping: generation)),
            "ui_heartbeat_age_ms": age.map { .integer(Int64(clamping: $0)) } ?? .null,
            "lease_remaining_ms": .integer(Int64(clamping: current.map {
                $0.expiresAtMilliseconds > now ? $0.expiresAtMilliseconds - now : 0
            } ?? 0)),
            "renewal_interval_ms": .integer(Int64(HostLeasePolicy.renewalIntervalMilliseconds)),
            "input_permit_ms": .integer(Int64(HostLeasePolicy.inputPermitMilliseconds)),
            "maximum_round_trip_ms": .integer(Int64(HostLeasePolicy.maximumChallengeRoundTripMilliseconds))
        ]
        if let current {
            result["session_id"] = .string(current.sessionID)
            result["sequence"] = .integer(Int64(clamping: current.sequence))
            result["challenge"] = .string(current.challenge)
        }
        return result
    }

    private func handle(_ request: HostRequest, connectionID: UUID) async -> HostResponse {
        let now = clock.milliseconds()
        if lease.expire(at: now) { clearActivityUI() }
        if (lease.active != nil || idleReference.armedID != nil || idleReference.isExporting)
            && !permission.isGranted { invalidateActivity() }
        do {
            switch request.action {
            case "health":
                var status = readiness(now: now)
                status["screen_capture_permission"] = .boolean(permission.isGranted)
                status["idle_reference_armed_id"] = idleReference.armedID.map { .string($0) } ?? .null
                status["idle_reference_exporting"] = .boolean(idleReference.isExporting)
                status["capabilities"] = .array(["capture", "begin_activity", "renew_activity",
                                                 "release_activity", "export_idle_reference"].map { .string($0) })
                status["input_service"] = .boolean(false)
                return .ok(request, status)
            case "begin_activity":
                try validateDisplay(request)
                try requireAvailable()
                guard capture.enabled else { throw HostCaptureError.notEnabled }
                guard !captureInProgress, !idleReference.isExporting else { throw HostLeaseError.busy }
                idleReference.invalidate()
                let session = try request.requiredString("session_id")
                let sequence = try request.requiredSequence()
                let challenge = try request.requiredString("challenge")
                try lease.begin(sessionID: session, connectionID: connectionID, sequence: sequence,
                                challenge: challenge, displayGeneration: generation, now: now)
                captureInProgress = true
                defer { captureInProgress = false }
                do {
                    // A complete excluded-app image must succeed before UI is shown.
                    _ = try await capture.snapshot(maximumDimension: 256)
                    let acknowledgedAt = clock.milliseconds()
                    let current = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                        displayGeneration: generation, now: acknowledgedAt)
                    try requireAvailable()
                    try permission.requireCapture(enabled: capture.enabled)
                    captureReady = true
                    overlayReady = renderer.show()
                    guard overlayReady else { throw HostLeaseError.notReady }
                    lastUIHeartbeat = acknowledgedAt
                    return .ok(request, readiness(now: acknowledgedAt, activity: current))
                } catch {
                    if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
                    throw error
                }
            case "renew_activity":
                try validateDisplay(request)
                try requireAvailable()
                guard permission.isGranted else {
                    // Permission withdrawal must revoke readiness before a new
                    // seat permit can be granted, even between screenshots.
                    if lease.release(connectionID: connectionID,
                                     sessionID: request.params["session_id"]?.string) { clearActivityUI() }
                    throw HostCaptureError.permissionRequired
                }
                try lease.renew(sessionID: request.requiredString("session_id"), connectionID: connectionID,
                    sequence: request.requiredSequence(), challenge: request.requiredString("challenge"),
                    displayGeneration: generation, now: now, uiHeartbeatAt: lastUIHeartbeat,
                    captureReady: captureReady, overlayReady: overlayReady && renderer.hasVisibleDisplayPanels)
                return .ok(request, readiness(now: now))
            case "release_activity":
                let session = try request.requiredString("session_id")
                _ = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                                            displayGeneration: generation, now: now)
                lease.release(connectionID: connectionID, sessionID: session)
                clearActivityUI()
                return .ok(request, readiness(now: now))
            case "capture", "screenshot":
                try validateDisplay(request)
                try requireAvailable()
                let size = try maximumDimension(request)
                let session = try request.requiredString("session_id")
                _ = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                                            displayGeneration: generation, now: now)
                guard HostLeaseState.isReady(now: now, uiHeartbeatAt: lastUIHeartbeat,
                    captureReady: captureReady, overlayReady: overlayReady && renderer.hasVisibleDisplayPanels),
                    !captureInProgress, !idleReference.isExporting else { throw HostLeaseError.notReady }
                captureInProgress = true
                defer { captureInProgress = false }
                do {
                    let image = try await capture.snapshot(maximumDimension: size)
                    let completedAt = clock.milliseconds()
                    let current = try lease.requireOwner(sessionID: session, connectionID: connectionID,
                        displayGeneration: generation, now: completedAt)
                    try requireAvailable()
                    try permission.requireCapture(enabled: capture.enabled)
                    guard HostLeaseState.isReady(now: completedAt, uiHeartbeatAt: lastUIHeartbeat,
                        captureReady: captureReady, overlayReady: overlayReady && renderer.hasVisibleDisplayPanels) else {
                        throw HostLeaseError.notReady
                    }
                    return .ok(request, readiness(now: completedAt, activity: current)
                        .merging(image.metadata) { _, imageValue in imageValue })
                } catch {
                    if lease.release(connectionID: connectionID, sessionID: session) { clearActivityUI() }
                    throw error
                }
            case "export_idle_reference":
                try validateDisplay(request)
                guard try request.requiredString("instance_id") == instanceID else {
                    throw HostIdleReferenceError.lifecycleChanged
                }
                let referenceID = try request.requiredString("reference_id")
                let exported = try await idleReference.export(armedID: referenceID,
                    connectionID: connectionID, binding: [
                    "instance_id": .string(instanceID), "capture_backend": .string("owned_sck"),
                    "displayGeneration": .integer(Int64(clamping: generation)),
                    "human_stop_latched": .boolean(!availability.humanAllowed),
                    "capture_enabled": .boolean(capture.enabled), "raw_vnc_exclusion": .boolean(false)
                ])
                updateHumanControl()
                return .ok(request, exported.metadata)
            default:
                return .failure(id: request.id, code: -32601, message: "unsupported_host_action")
            }
        } catch let error as HostLeaseError {
            return .failure(id: request.id, message: error.rawValue)
        } catch let error as HostCaptureError {
            return .failure(id: request.id, message: error.rawValue)
        } catch let error as HostIdleReferenceError {
            return .failure(id: request.id, message: error.rawValue)
        } catch {
            return .failure(id: request.id, message: "host_action_failed")
        }
    }

    static func writeError(_ message: String) {
        try? FileHandle.standardError.write(contentsOf: Data(message.utf8))
    }
}

@main
struct FruitctlHostMain {
    @MainActor
    static func main() {
        // Broken SSH/pipe output must become a transport failure, not leave a
        // half-attached helper. This changes signals only in this process.
        signal(SIGPIPE, SIG_IGN)
        do {
            let options = try HostOptions.parse(Array(CommandLine.arguments.dropFirst()))
            switch options.mode {
            case .help:
                print("""
                FruitctlHost — optional macOS human activity indicator and owned SCK capture
                Usage: FruitctlHost [--enable-capture | --disable-capture] [--request-screen-capture] [--display-id ID]
                       FruitctlHost --stdio
                       FruitctlHost --doctor
                --stdio attaches to an already running same-user Aqua app; it never launches UI.
                Capture starts disabled on fresh installs; explicit operator opt-in persists.
                The local menu can enable/disable capture; IPC cannot change the opt-in.
                Permission requests require the explicit
                --enable-capture --request-screen-capture attended application flags.
                Raw VNC exclusion is unsupported. Input stays on the controlling Darwin seat.
                """)
            case .doctor:
                var info = stat()
                let path = HostIPC.socketPath
                let socketPresent = lstat(path, &info) == 0 && info.st_uid == getuid()
                    && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) && info.st_mode & 0o077 == 0
                let report: [String: HostValue] = [
                    "socket_present": .boolean(socketPresent), "raw_vnc_exclusion": .boolean(false),
                    "screen_capture_permission": .boolean(CGPreflightScreenCaptureAccess()),
                    "bundle_id": .string(Bundle.main.bundleIdentifier ?? "unbundled"),
                    "gui_started": .boolean(false), "capture_started": .boolean(false)
                ]
                try FileHandle.standardOutput.write(contentsOf:
                    HostResponse(id: nil, success: true, result: report, error: nil).line())
            case .stdio:
                try HostIPC.attachStdio()
            case .application:
                let app = NSApplication.shared
                let controller = HostApplicationController(options: options)
                app.delegate = controller
                withExtendedLifetime(controller) { app.run() }
            }
        } catch {
            HostApplicationController.writeError("FruitctlHost: unavailable or invalid invocation. Use --help.\n")
            exit(1)
        }
    }
}
