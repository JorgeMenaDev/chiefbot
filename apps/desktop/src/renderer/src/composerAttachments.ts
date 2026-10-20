// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/chat/composerAttachmentFiles.ts
// and ChatComposer.tsx's addComposerAttachments: which files the composer takes, their types, and its messages.
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MimeType, type AttachmentUpload } from "@chiefbot/contracts";

// A file in the composer, waiting to be sent. `data` is its bytes in base64.
export type DraftAttachment = AttachmentUpload & { id: string; size: number };

// The image types the composer shows as thumbnails (T3 Code's), by extension.
const imageTypes: Record<string, string> = { gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export const isImage = (mimeType: string) => Object.values(imageTypes).includes(mimeType);

// The file's type. A file dragged from another app may come without one, so an
// image's extension names it; anything else unknown is plain bytes.
export function typeOf({ name, type }: Pick<File, "name" | "type">) {
  if (type !== "application/octet-stream" && MimeType.safeParse(type).success) return type;
  return imageTypes[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

// The chip that stands for a file in the prompt: its name in brackets, which the
// composer and the chat draw as a chip.
export const chipFor = (name: string) => `[${name}]`;

// `name`, or with -2, -3… before its extension when a file in `taken` has it: a
// message's files need their own names, and a pasted screenshot is always image.png.
export function uniqueName(name: string, taken: ReadonlySet<string>) {
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem}-${n}${extension}`;
  return candidate;
}

// Which of `files` fit beside the `attached` ones, and what was wrong with the
// last one that did not (T3 Code's messages). Control checks the same limits.
export function admit(files: File[], attached: number): { files: File[]; error: string | null } {
  const admitted: File[] = [];
  let error: string | null = null;
  for (const file of files) {
    if (attached + admitted.length >= MAX_ATTACHMENTS) error = `You can attach up to ${MAX_ATTACHMENTS} files per message.`;
    else if (file.size === 0) error = `'${file.name}' is empty or could not be read.`;
    else if (file.size > MAX_ATTACHMENT_BYTES) error = `'${file.name}' exceeds the 10 MB attachment limit.`;
    else admitted.push(file);
  }
  return { files: admitted, error };
}

// Reads admitted files into the composer, each named apart from the `taken` names.
export function readAttachments(files: File[], taken: ReadonlySet<string>): Promise<DraftAttachment[]> {
  const names = new Set(taken);
  return Promise.all(
    files.map(async (file) => {
      const name = uniqueName(file.name || "file", names);
      names.add(name);
      return { id: crypto.randomUUID(), name, mimeType: typeOf(file), size: file.size, data: await base64Of(file) };
    }),
  );
}

// The browser's own base64 encoder: the part of a data: URL after its comma.
function base64Of(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

// T3 Code's size label.
export const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`);
