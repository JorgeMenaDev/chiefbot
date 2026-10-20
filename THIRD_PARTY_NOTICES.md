# Third-party notices

## T3 Code

https://github.com/pingdotgg/t3code

Used in:

- the desktop design system: the theme tokens in `apps/desktop/src/renderer/src/styles.css` are adapted from `apps/web/src/index.css`, and the primitives in `apps/desktop/src/renderer/src/components/ui/` (button, card, badge, input, alert, spinner, empty, sidebar, menu, dialog) and `lib/utils.ts` from `apps/web/src/components/ui/` and `apps/web/src/lib/utils.ts`, with the dialog glass and backdrop in `styles.css`.
- the sidebar in `apps/desktop/src/renderer/src/components/ui/sidebar.tsx` (hiding off the left edge, the toggle beside the macOS window buttons and its Mod+B shortcut, the search row and its icon actions, the settings button at the bottom left) is adapted from `apps/web/src/components/ui/sidebar.tsx`, `AppSidebarLayout.tsx`, `sidebar/SidebarChrome.tsx` and `sidebar/SidebarThreadHeader.tsx`; the settings menu in `components/ui/menu.tsx` from `apps/web/src/components/ui/menu.tsx` and the `dropdown-glass` utility in `apps/web/src/index.css`.
- the bot status dot in `apps/desktop/src/renderer` (colour per status and the ping while starting) is adapted from `apps/web/src/components/ConnectionStatusDot.tsx`.
- the model picker in `apps/desktop/src/renderer/src/ModelPicker.tsx` (`ModelPicker`, `ModelRow`) is adapted from `apps/web/src/components/chat/ProviderModelPicker.tsx` and `ModelListRow.tsx`, through Chartpilot's port (https://github.com/JorgeMenaDev/chartpilot, `components/composer-controls.tsx`). Its Copilot mark is GitHub's Octicon (MIT).
- the theme setting: the mode tiles and their picture of the app in `apps/desktop/src/renderer/src/Settings.tsx` are adapted from `apps/web/src/components/settings/ThemeSettings.tsx` and `ThemeWireframe.tsx`; the class-based dark variant in `styles.css`, the saved theme applied before the app loads (`apps/desktop/src/renderer/public/theme-boot.js`) and in `lib/theme.ts`, and Electron's native theme set to match, from `apps/web/index.html`, `apps/web/src/index.css`, `apps/web/src/hooks/useTheme.ts` and `apps/desktop/src/electron/ElectronTheme.ts`.
- the composer: its card, prompt and footer in `apps/desktop/src/renderer/src/Composer.tsx` are adapted from `apps/web/src/components/chat/ChatComposer.tsx` and `ComposerSurface.tsx`; its controls in `ComposerControl.tsx` from `ComposerControl.tsx`; the reasoning effort and access mode pickers and the narrow composer's "…" menu in `BotComposerControls.tsx` from `TraitsPicker.tsx`, `runtimeModeConfig.ts`, the runtime mode select in `ChatComposer.tsx` and `CompactComposerControlsMenu.tsx`; and the menu's radio row in `components/ui/menu.tsx` from `apps/web/src/components/ui/menu.tsx`.
- the composer's files: their types, limits and messages in `apps/desktop/src/renderer/src/composerAttachments.ts` are adapted from `apps/web/src/components/chat/composerAttachmentFiles.ts` and `addComposerAttachments` in `ChatComposer.tsx`; paste, drop and the paperclip in `Composer.tsx` from `ChatComposer.tsx`; the chip, the tray, the file rows and a sent message's images and files in `Attachments.tsx` from `apps/web/src/components/ContextChip.tsx`, `ChatComposer.tsx` and `MessagesTimeline.tsx`; and the `media-close` button in `components/ui/button.tsx` from `apps/web/src/components/ui/button.tsx`.
- the approval card in `apps/desktop/src/renderer/src/ApprovalCard.tsx` (label per request kind, the exact command in monospace, Decline and Approve) is adapted from `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx` and `ComposerPendingApprovalActions.tsx`.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## noVNC

https://github.com/novnc/noVNC

Used in: the bot screen in `apps/desktop/src/renderer` runs the `@novnc/novnc` npm package (1.7, unmodified) as its VNC client. noVNC is licensed under the Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/). Its source is at the link above and in `node_modules/@novnc/novnc`.
