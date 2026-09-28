import { value05 } from "./m05.js";

export const name10 = "m10";

export function value10(x) {
  return x + 10;
}

export function double10(x) {
  return value10(x) * 2;
}

export function combined10(x) {
  return value05(x) + 10;
}
