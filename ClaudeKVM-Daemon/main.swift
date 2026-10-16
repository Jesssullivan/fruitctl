import Foundation
import ArgumentParser

@main
struct ClaudeKVMDaemon: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "claude-kvm-daemon",
        abstract: "Native VNC client daemon for Claude KVM (Apple Silicon)",
        discussion: """
             █████╗ ██████╗  █████╗ ███████╗
            ██╔══██╗██╔══██╗██╔══██╗██╔════╝
            ███████║██████╔╝███████║███████╗
            ██╔══██║██╔══██╗██╔══██║╚════██║
            ██║  ██║██║  ██║██║  ██║███████║
            ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝

            Copyright (c) 2026 Riza Emre ARAS <r.emrearas@proton.me>
            Released under the MIT License - see LICENSE for details.

            Long-running VNC client daemon for AI-driven desktop control.
            Communicates via PC (Procedure Call) over stdin/stdout NDJSON.
            macOS is detected automatically when ARD auth (type 30) is used.

            PROTOCOL:
              Reads PC requests from stdin, writes PC responses to stdout.
              Each line is a single JSON object (NDJSON).

              Request:      {"method":"<name>","params":{...},"id":<int|string>}
              Response:     {"result":{...},"id":<int|string>}
              Error:        {"error":{"code":<int>,"message":"..."},"id":<int|string>}
              Notification: {"method":"<name>","params":{...}}

            METHODS:
              Screen:
                screenshot                              Scaled PNG of full screen
                cursor_crop                             Crop around cursor with crosshair
                diff_check                              Any pixel change since baseline
                set_baseline                            Save current frame for diff comparison

              Mouse:
                mouse_move     {x, y}                   Teleport cursor
                hover          {x, y}                   Move + settle wait
                nudge          {dx, dy}                 Relative cursor move
                mouse_click    {x, y, button?, modifiers?} Click (left|right|middle), modifiers held around it
                mouse_double_click {x, y}               Double click
                triple_click   {x, y}                   Triple click
                mouse_drag     {x, y, toX, toY, button?} Drag with interpolated path
                scroll         {x, y, direction, amount?} Scroll (up|down|left|right)
                cursor_position                         fruitctl-tracked position (not the server cursor)
                mouse_down     {x, y, button?, hold_scope} Press and hold within one batch scope
                mouse_up       {x?, y?, button?, hold_scope} Release a held button
                release_holds  {hold_scope}             Batch end: release any live hold

              Keyboard:
                key_tap        {key}                    Single key press-release
                key_combo      {key} or {keys:[...]}    Modifier combo (e.g. "cmd+c")
                hold_key       {key, duration_ms}       Hold one key, then release in the same call
                key_type       {text}                   Type text character by character
                paste          {text}                   Paste via clipboard + combo

              Detection:
                detect_elements                         OCR text detection with bounding boxes

              Configuration:
                configure      {<params>}               Set timing/display params at runtime
                configure      {reset: true}            Reset all params to defaults
                get_timing                              Get current timing + display params

              Control:
                wait           {ms?}                    Pause (default 500ms)
                health                                  Connection state + display info
                shutdown                                Graceful exit

            CONFIGURE PARAMETERS (all optional, runtime-adjustable via PC):
              All timing values are in milliseconds.
              Default values are used at startup — no CLI overrides needed.
              Use the "configure" method to change values at runtime.
              Use "get_timing" to inspect current values.

              Display:
                max_dimension        Max screenshot dimension in px    (default: 1280)
                cursor_crop_radius   Cursor crop radius in px         (default: 150)

              Mouse:
                click_hold_ms        Click hold duration               (default: 50)
                double_click_gap_ms  Inter-click gap                   (default: 50)
                hover_settle_ms      Hover settle wait                 (default: 400)

              Drag:
                drag_position_ms     Position settle before press      (default: 30)
                drag_press_ms        Press hold for drag threshold     (default: 50)
                drag_step_ms         Between interpolation points      (default: 5)
                drag_settle_ms       Settle before release             (default: 30)
                drag_pixels_per_step Point density in pixels           (default: 20)
                drag_min_steps       Minimum interpolation steps       (default: 10)

              Scroll:
                scroll_press_ms      Scroll press-release gap          (default: 10)
                scroll_tick_ms       Inter-tick delay                  (default: 20)

              Keyboard:
                key_hold_ms          Single key hold duration          (default: 30)
                combo_mod_ms         Modifier settle delay             (default: 10)

              Typing:
                type_key_ms          Key hold during typing            (default: 20)
                type_inter_key_ms    Between characters                (default: 20)
                type_shift_ms        Shift key settle                  (default: 10)
                paste_settle_ms      After clipboard write             (default: 30)

            CONFIGURE EXAMPLES:
              Set timing:
                {"method":"configure","params":{"click_hold_ms":80,"key_hold_ms":50},"id":1}
                → {"result":{"detail":"OK — changed: click_hold_ms, key_hold_ms"},"id":1}

              Change display scaling:
                {"method":"configure","params":{"max_dimension":960},"id":2}
                → {"result":{"detail":"OK — changed: max_dimension","scaledWidth":960,"scaledHeight":584},"id":2}

              Reset to defaults:
                {"method":"configure","params":{"reset":true},"id":3}
                → {"result":{"detail":"OK — reset to defaults","timing":{...}},"id":3}

              Get current values:
                {"method":"get_timing","id":4}
                → {"result":{"timing":{"click_hold_ms":50,...},"scaledWidth":1280,"scaledHeight":779},"id":4}

            NOTIFICATIONS (server → caller, no id):
              vnc_state      {state}                    Connection state changes
              ready          {scaledWidth, scaledHeight} VNC connected, dimensions

            COORDINATE SYSTEM:
              All coordinates are in scaled display space.
              Native resolution is scaled to fit within max_dimension (default 1280).
              Example: 4220×2568 native → 1280×779 scaled (at max 1280)
              max_dimension can be changed at runtime via configure.

            macOS DETECTION:
              Automatic via ARD auth type 30 credential request.
              When detected, Meta_L/R keysyms are written as Super_L/R
              (Command) and Alt_L/R as Meta_L/R (Option), the modifiers
              Apple's Screen Sharing server reads.

            EXAMPLES:
              Launched by the MCP proxy with --password-fd 3.
              Descriptor 3 carries a bounded credential frame; stdin remains PC NDJSON.
              Plaintext password arguments and environment fallbacks are unsupported.

            REQUEST MODES (--rfb-request-mode):
              stream     Default. Incremental polls while idle; LibVNC re-arms an
                         incremental request after every update, so results
                         report ordered_after_prior_input false.
              on-demand  No incremental request is written. Each observation
                         sends one whole-screen request; results carry
                         provenance with the request counts and report
                         ordered_after_prior_input true only when no earlier
                         request was outstanding.

            INPUT SETTLE (--input-settle-ms):
              Apple Screen Sharing silently drops all input for about 2.5 s
              after authentication. The first input of each connection waits
              until N ms after ServerInit (default 3000 on Apple, 0 otherwise);
              a reconnect restarts it. Observation is never delayed. health
              reports input_ready and input_settle_remaining_ms.

            ERRORS:
              Screen observations that obtain no fresh complete frame return
              code -32010 with data.reason (server_silent, metadata_only,
              incomplete_coverage, late_complete, allocation_changed,
              disconnected, request_failed, capture_busy, cancelled) and
              data.diagnostics.
              Input that cannot wait out the settle time within its deadline
              returns code -32013, data.reason input_not_ready and
              data.remaining_ms; no event is written.
              Input refusals return code -32011 with data.reason
              (hold_outside_batch, button_already_held, button_not_held)
              before any event of the refused request.

            INPUT HOLDS:
              mouse_down/mouse_up require the hold_scope an executor assigns
              to one action_queue batch. A request without that scope first
              force-releases the hold; release_holds ends it at batch end.
              Before the first input of each connection, every modifier gets
              one release-only key-up.

            OUTPUT:
              stdout  PC responses and notifications (NDJSON).
              stderr  Verbose logs (-v), errors ([ERROR] prefix) and, with
                      --rfb-wire-ledger, [RFB-WIRE] header-only lines. Input
                      is coalesced into one line per run (no counts, timing
                      or lengths).
              exit 0  Clean shutdown.
              exit 1  Connection failure.
            """
    )

    // MARK: - VNC Connection

    @Option(name: .long, help: "VNC server hostname or IP address.")
    var host: String = "127.0.0.1"

    @Option(name: .long, help: "VNC server port.")
    var port: Int = 5900

    @Option(name: .long, help: "VNC username (required for macOS ARD auth).")
    var username: String?

    @Option(name: .customLong("password-fd"), help: "Private credential pipe/socket descriptor (must be 3).")
    var passwordFD: Int32

    @Option(name: .long, help: "VNC connect timeout in seconds.")
    var connectTimeout: Int?

    // MARK: - Display

    @Option(name: .long, help: "Initial max screenshot dimension in pixels (adjustable at runtime via configure).")
    var maxDimension: Int = 1280

    // MARK: - VNC Tuning

    @Option(name: .long, help: "Bits per sample.")
    var bitsPerSample: Int?

    @Option(name: .long, help: "Reconnect delay in seconds.")
    var reconnectDelay: Double?

    @Option(name: .long, help: "Max reconnect attempts.")
    var maxReconnectAttempts: Int?

    @Flag(name: .long, help: "Disable auto-reconnect on connection loss.")
    var noReconnect: Bool = false

    // MARK: - RFB Diagnostics

    @Flag(name: .customLong("rfb-wire-ledger"),
          help: "Write a header-only client-to-server RFB ledger to stderr (request type, incremental flag, length, monotonic ms; input coalesced without counts, timing or lengths; never payloads).")
    var rfbWireLedger: Bool = false

    @Option(name: .customLong("input-settle-ms"),
            help: "Hold input until N ms after ServerInit on each connection (0...10000). Default: 3000 for Apple Screen Sharing (ARD), else 0.")
    var inputSettleMs: Int?

    @Option(name: .customLong("rfb-request-mode"),
            help: "Framebuffer request mode: stream (default) or on-demand (no incremental requests; LibVNC's own requests are gated off).")
    var rfbRequestMode: String = VNCRequestMode.stream.rawValue

    // MARK: - General

    @Flag(name: [.short, .long], help: "Enable verbose logging to stderr.")
    var verbose: Bool = false

    // MARK: - Run

    func validate() throws {
        guard (1...65535).contains(port) else { throw ValidationError("--port must be 1...65535") }
        guard (320...3840).contains(maxDimension) else { throw ValidationError("--max-dimension must be 320...3840") }
        if let bits = bitsPerSample, bits != 8 { throw ValidationError("Only 8-bit RGBA samples are supported") }
        if let timeout = connectTimeout, !(1...120).contains(timeout) {
            throw ValidationError("--connect-timeout must be 1...120 seconds")
        }
        if let delay = reconnectDelay, !delay.isFinite || !(0.1...30).contains(delay) {
            throw ValidationError("--reconnect-delay must be 0.1...30 seconds")
        }
        if let attempts = maxReconnectAttempts, !(0...100).contains(attempts) {
            throw ValidationError("--max-reconnect-attempts must be 0...100")
        }
        if let settle = inputSettleMs, !(0...VNCInputSettle.maximumMilliseconds).contains(settle) {
            throw ValidationError("--input-settle-ms must be 0...10000")
        }
        guard VNCRequestMode(rawValue: rfbRequestMode) != nil else {
            throw ValidationError("--rfb-request-mode must be stream or on-demand")
        }
    }

    func run() async throws {
        try await runDaemon()
    }

    // MARK: - Daemon

    private func runDaemon() async throws {
        signal(SIGPIPE, SIG_IGN)
        let password = try CredentialInput.readInherited(fd: passwordFD)
        log("Starting daemon — VNC \(host):\(port)")

        var vncConfig = VNCConfiguration(
            host: host,
            port: port,
            username: username,
            password: password
        )
        if let timeout = connectTimeout { vncConfig.connectTimeout = timeout }
        if let bps = bitsPerSample { vncConfig.bitsPerSample = Int32(bps) }
        if let delay = reconnectDelay { vncConfig.reconnectDelay = delay }
        if let max = maxReconnectAttempts { vncConfig.maxReconnectAttempts = max }
        if noReconnect { vncConfig.autoReconnect = false }
        vncConfig.wireLedger = rfbWireLedger
        vncConfig.requestMode = VNCRequestMode(rawValue: rfbRequestMode) ?? .stream
        vncConfig.inputSettleMilliseconds = inputSettleMs

        let vnc = VNCBridge(config: vncConfig)
        vnc.verbose = verbose

        vnc.onStateChange = { state in
            self.notify("vnc_state", params: ["state": .string("\(state)")])
        }

        do {
            try await vnc.connect()
        } catch {
            printError("VNC connection failed: \(error.localizedDescription)")
            throw ExitCode.failure
        }

        log("macOS mode: \(vnc.isMacOS); input settle: \(vnc.inputSettle.status().settleMilliseconds) ms")

        let scaling = DisplayScaling(
            nativeWidth: vnc.framebufferWidth,
            nativeHeight: vnc.framebufferHeight,
            maxDimension: maxDimension
        )
        log("Display: \(scaling.nativeWidth)×\(scaling.nativeHeight) → \(scaling.scaledWidth)×\(scaling.scaledHeight)")

        notify("ready", params: [
            "scaledWidth": .int(scaling.scaledWidth),
            "scaledHeight": .int(scaling.scaledHeight),
            "capabilities": .strings(PCRequest.supportedMethods),
        ])

        let input = InputController(vnc: vnc)

        let commandTask = Task { await runCommandLoop(vnc: vnc, input: input, scaling: scaling) }
        // Cancel the owning loop, which unwinds the current input action and
        // releases held state before disconnect. A signal never replays input.
        let signalSources = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated))
            source.setEventHandler { commandTask.cancel() }
            source.resume()
            return source
        }
        defer {
            for source in signalSources { source.cancel() }
        }
        await commandTask.value
        let released = await input.releaseHeldInput()

        vnc.disconnect()
        guard released else {
            printError("Native shutdown could not confirm held-state release")
            throw ExitCode.failure
        }
        log("Daemon stopped")
    }

    // MARK: - PC Emission

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = .sortedKeys
        return e
    }()

    private static let outputLock = NSLock()

    func respond(_ response: PCResponse) {
        Self.outputLock.lock()
        defer { Self.outputLock.unlock() }
        guard let data = try? Self.encoder.encode(response),
              let json = String(data: data, encoding: .utf8) else { return }
        print(json)
        fflush(stdout)
    }

    func notify(_ method: String, params: [String: PCValue]? = nil) {
        Self.outputLock.lock()
        defer { Self.outputLock.unlock() }
        let notification = PCNotification(method: method, params: params)
        guard let data = try? Self.encoder.encode(notification),
              let json = String(data: data, encoding: .utf8) else { return }
        print(json)
        fflush(stdout)
    }

    // MARK: - Logging

    func log(_ message: String) {
        guard verbose else { return }
        let ts = timestamp()
        FileHandle.standardError.write(Data("[DAEMON \(ts)] \(message)\n".utf8))
    }

    func printError(_ message: String) {
        FileHandle.standardError.write(Data("[ERROR] \(message)\n".utf8))
    }

    private func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter.string(from: Date())
    }
}
