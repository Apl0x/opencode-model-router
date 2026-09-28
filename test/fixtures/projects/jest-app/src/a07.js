const { value03 } = require("./a03");

function value07(x) {
  return x * 7;
}

function label07() {
  return "a07";
}

function chained07(x) {
  return value03(x) + 7;
}

module.exports = { value07, label07, chained07 };
