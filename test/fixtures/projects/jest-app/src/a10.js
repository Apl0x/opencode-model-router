const { value05 } = require("./a05");

function value10(x) {
  return x * 10;
}

function label10() {
  return "a10";
}

function chained10(x) {
  return value05(x) + 10;
}

module.exports = { value10, label10, chained10 };
