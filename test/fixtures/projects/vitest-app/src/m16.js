import { value08 } from "./m08.js";

export const name16 = "m16";

export function value16(x) {
  return x + 16;
}

export function double16(x) {
  return value16(x) * 2;
}

export function combined16(x) {
  return value08(x) + 16;
}
