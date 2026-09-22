/** Wire protocol version spoken by this build. Sent as `v` in every message. */
export const PROTOCOL_VERSION = 1;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Protocol versions this build can decode. */
export const SUPPORTED_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

export function isSupportedVersion(v: unknown): v is ProtocolVersion {
  return typeof v === "number" && SUPPORTED_VERSIONS.includes(v);
}
