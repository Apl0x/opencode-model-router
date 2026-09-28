import { value02 } from "./m02.js";

export const name05 = "m05";

export function value05(x) {
  return x + 5;
}

export function double05(x) {
  return value05(x) * 2;
}

export function combined05(x) {
  return value02(x) + 5;
}
