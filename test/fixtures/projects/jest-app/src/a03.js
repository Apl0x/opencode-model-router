const { value01 } = require("./a01");

function value03(x) {
  return x * 3;
}

function label03() {
  return "a03";
}

function chained03(x) {
  return value01(x) + 3;
}

module.exports = { value03, label03, chained03 };
