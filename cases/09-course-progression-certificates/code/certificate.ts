/**
 * A certificate is a public page, not a private screen.
 *
 * Anyone with the number may open the verification URL and confirm that the
 * course, the holder, and the issue date are real. Because the page is public,
 * "is this mine?" is not an access check — access is open by design — it only
 * decides which wording to use in the share copy and whether to show the
 * "we emailed this to you" note. Ownership is established by the session; the
 * name comparison here is a presentation hint, and treating it as a security
 * boundary would be a mistake.
 *
 * The page also owns a small download state machine: rendering the artwork and
 * rasterising it to a file is slow enough that the button must disable itself
 * while it runs and recover from a failure without losing the page.
 */

export interface Certificate {
  number: string;
  holderName: string;
  courseName: string;
  courseSlug: string | null;
  issuedAt: string | null;
  duration: string | null;
}

export interface Viewer {
  name: string | null;
}

export interface ShareCopy {
  selfText: string;
  otherText: string;
  hint: string;
}

export interface SharePayload {
  text: string;
  description: string;
  url: string;
}

export type DownloadState =
  | { status: "idle" }
  | { status: "preparing" }
  | { status: "ready"; url: string }
  | { status: "failed"; message: string };

export const initialDownload: DownloadState = { status: "idle" };

/** Collapse case and whitespace so "Ada  Lovelace" matches "ada lovelace". */
const foldName = (value: string | null | undefined): string =>
  (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export function isOwner(certificate: Certificate, viewer: Viewer | null): boolean {
  const holder = foldName(certificate.holderName);
  return holder !== "" && holder === foldName(viewer?.name);
}

/**
 * The canonical, shareable verification URL. Pure, so it can be rendered on
 * the server and signed without touching `window`.
 */
export function verifyUrl(
  origin: string,
  certificateNumber: string,
  basePath = "/courses/certificate",
): string {
  return `${origin.replace(/\/+$/, "")}${basePath}/${encodeURIComponent(certificateNumber)}`;
}

export function sharePayload(
  certificate: Certificate,
  viewer: Viewer | null,
  copy: ShareCopy,
  origin: string,
  basePath?: string,
): SharePayload {
  const template = isOwner(certificate, viewer) ? copy.selfText : copy.otherText;

  return {
    text: template
      .replace("{course}", certificate.courseName)
      .replace("{name}", certificate.holderName),
    description: copy.hint,
    url: verifyUrl(origin, certificate.number, basePath),
  };
}

export const canDownload = (state: DownloadState): boolean =>
  state.status === "idle" || state.status === "failed";

/** Starting while already preparing is a no-op, so a double click cannot queue
 *  two render jobs. */
export function beginDownload(state: DownloadState): DownloadState {
  return state.status === "preparing" ? state : { status: "preparing" };
}

export function finishDownload(state: DownloadState, url: string): DownloadState {
  return state.status === "preparing" ? { status: "ready", url } : state;
}

export function failDownload(state: DownloadState, message: string): DownloadState {
  return state.status === "preparing" ? { status: "failed", message } : state;
}
