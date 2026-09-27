const WINDOWS_RESERVED_BASENAME_RE =
  /^(?:con|prn|aux|nul|com(?:[1-9\u00b9\u00b2\u00b3])|lpt(?:[1-9\u00b9\u00b2\u00b3]))(?:\..*)?$/i;

export function isSafeWindowsLocalSegment(segment) {
  if (typeof segment !== "string" || segment.length === 0 || segment.length > 255) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.endsWith(".") || segment.endsWith(" ")) return false;
  if (/[<>:"/\\|?*]/.test(segment)) return false;
  if (/[\u0000-\u001f\u007f]/.test(segment)) return false;
  if (WINDOWS_RESERVED_BASENAME_RE.test(segment)) return false;
  return true;
}

export function isSafeWindowsRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.split("/");
  return segments.length > 0 && segments.every(isSafeWindowsLocalSegment);
}
