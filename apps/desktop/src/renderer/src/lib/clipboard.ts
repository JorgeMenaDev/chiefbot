// Writes `text` to `clipboard` (pass `navigator.clipboard`). Resolves whether it
// worked and never throws: the clipboard can be missing, throw or refuse.
export async function copyText(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined): Promise<boolean> {
  try {
    if (!clipboard) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
