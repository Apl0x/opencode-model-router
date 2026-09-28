import { value10 } from "./m10.js";

export const name20 = "m20";

export function value20(x) {
  return x + 20;
}

export function double20(x) {
  return value20(x) * 2;
}

export function combined20(x) {
  return value10(x) + 20;
}
