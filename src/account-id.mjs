// Native account labels are opaque identifiers, not filenames. Preserve email
// addresses and Unicode; callers encode the whole label as one URL segment.
export const isAccountNativeId = (value) => typeof value === "string" &&
  value.length >= 1 && value.length <= 200 && value.isWellFormed() &&
  value.trim().length > 0 && value !== "." && value !== ".." &&
  !/[\x00-\x1f\x7f-\x9f/\\%?#]/u.test(value);

export const isAccountId = (value) => {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  return separator > 0 && /^[a-z][a-z0-9_-]{0,63}$/.test(value.slice(0, separator)) &&
    isAccountNativeId(value.slice(separator + 1));
};
