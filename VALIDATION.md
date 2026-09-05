# Validation

2026-09-05 / macOS

- `npm test`: 22 tests passed. Tachyon SDP exchange, mute and text send, incremental transcripts, cancellation during microphone acquisition, provider errors, unsafe URL rejection, and token storage behavior use injected browser/HTTP doubles. Cognito login, MFA/OTP/new-password challenges, refresh singleflight, stale refresh after logout, invalid refresh, timeout, and Tachyon user-token/tenant/chatroom contracts are covered.
- `npm run build`: TypeScript and Vite production build passed.
- `CARGO_TARGET_DIR=/private/tmp/jarvis-cargo-target cargo check --manifest-path src-tauri/Cargo.toml`: passed with Tauri 2.11.5 and tauri-plugin-http 2.6.0.
- Native debug executable rebuilt with Tachyon login and bundled successfully. `tauri bundle --debug --bundles app --no-sign` passed after generating a macOS ICNS icon. Copied the complete Apple Silicon app to `artifacts/JARVIS.app`; its Info.plist passes `plutil -lint`.
- Local browser: actual WebGPU/vgpu shader rendering confirmed. Fixed nested frame submission and a WGSL reserved identifier found during live rendering. Renderer fallback was also observed during validation failures.
- Local browser: Tachyon login opens with built-in public client configuration; Escape cancels login and reopening shows empty credential inputs; login form layout visually checked; conversation suggestions populate the composer; disconnected send remains disabled.

Not yet verified: real Cognito login/MFA/token refresh, authenticated Tachyon/OpenAI voice conversation, real microphone capture and audio output, native microphone/audio behavior, signed distribution.

Native UI: the updated artifacts/JARVIS.app launched successfully. The tauri://localhost page reports WebGPU / vgpu. Clicking Tachyonにログイン opens the username and secure password fields. Real credentials were not entered.

The browser preview does not imply native or authenticated audio proof. For the native application, use the README's Tauri commands and log in locally with a Tachyon account.

## Golden hologram revision (PLT-4230)

- Replaced the opaque blue raymarched sphere with five transparent, rotating circuit shells, segmented orbital arcs, nodes, and a small luminous core. Updated the surrounding UI and CSS fallback to amber/gold.
- Actual browser WebGPU output visually reviewed against the user-provided reference. Increased line luminance and replaced the solid center with visible circuit rings after the first review.
- TypeScript/Vite production build passed. Device-pixel-ratio capped at 1.5 for the denser shader.
- Updated native debug bundle rebuilt successfully, copied to artifacts/JARVIS.app, and launched. Native WebGPU / vgpu status and golden circuit-sphere appearance confirmed by screenshot.

## AI motion revision (PLT-4231)

- Added distinct idle/listening/thinking/speaking visuals. Thinking accelerates independently rotating shells and a traveling highlight; speaking changes diameter, slight deformation, luminance, and rotation from remote audio RMS.
- GPU motion uses elapsed-time interpolation for state transitions and separate attack/release smoothing for audio levels. Motion phase is integrated so changing activity does not jump rotation angles. CSS fallback has corresponding state styles; reduced-motion settings suppress movement.
- Development-only motion fixture verified in browser with actual WebGPU: thinking, synthetic speaking amplitude, and return to idle. This is visual simulation, not proof of live API/audio timing.
- Full suite: 25 tests passed; TypeScript/Vite production build passed; Tauri native debug bundle passed. Copied updated app to artifacts/motion/JARVIS.app, preserving the running signed-in app. The motion revision has not been verified against a live voice conversation.

## Irregular motion revision (PLT-4232)

- Integrated smoothly interpolated deterministic noise into rotation speed, with independent shell-axis drift. Fixed circuit cells fade in/out through smooth density thresholds and moving local density fields.
- Actual browser WebGPU output checked at different times in thinking mode; density and orientation changes observed. Corrected a WGSL reserved identifier caught by shader validation. TypeScript/Vite build passed.
- Native debug bundle passed and copied to artifacts/irregular/JARVIS.app. Running apps were not interrupted.

## Compact layout (PLT-4233)

- Removed the connection/renderer/model strip. Conversation panel defaults closed, with header toggle and in-panel close button. Closed panel is hidden from layout and accessibility tree; messages/draft are retained.
- Browser verified initial closed state, open/close, draft retained after reopening, Escape closure and focus return. Closed layout visually reviewed. TypeScript/Vite production build passed.
- Native debug bundle passed and copied to artifacts/compact/JARVIS.app; running signed-in apps left intact.

## Browser login fix (PLT-4235)

- Reproduced browser-only `Illegal invocation` before any network request when native fetch was called with an AuthSession-like receiver. The same localhost probe returned HTTP 200 with a receiver-neutral wrapper.
- AuthSession now invokes injected fetch through a wrapper. Added a receiver-sensitive regression test; all 26 tests passed. Removed temporary browser probe after verifying the fix.
- Reloaded localhost and reopened login. Real credential submission is left to the user; authenticated completion has not yet been reverified for this browser revision.

## Full viewport background (PLT-4236)

- Moved CoreScene out of the content grid into a fixed viewport background. Enlarged canvas by 1.24, disabled background pointer events, and added foreground contrast gradients and a translucent conversation panel. CSS fallback also scales with viewport.
- Actual browser screenshots reviewed with conversation closed and open: sphere remains at the same viewport location and size, panel overlaps it, and controls work. Existing signed-in session preserved during HMR. TypeScript/Vite build passed.
- Native debug bundle passed and copied to artifacts/background/JARVIS.app; running applications left intact.
