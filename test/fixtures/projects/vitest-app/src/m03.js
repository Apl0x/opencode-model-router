import { value01 } from "./m01.js";

export const name03 = "m03";

export function value03(x) {
  return x + 3;
}

export function double03(x) {
  return value03(x) * 2;
}

export function combined03(x) {
  return value01(x) + 3;
}
