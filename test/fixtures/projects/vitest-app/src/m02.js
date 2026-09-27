import { value01 } from "./m01.js";

export const name02 = "m02";

export function value02(x) {
  return x + 2;
}

export function double02(x) {
  return value02(x) * 2;
}

export function combined02(x) {
  return value01(x) + 2;
}
