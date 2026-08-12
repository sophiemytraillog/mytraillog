import crypto from "crypto";

// Excludes 0/O and 1/I — easy to misread when someone's typing a code off a
// text message or a printed flyer.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateInviteCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  }
  return `MTL-${code}`;
}
