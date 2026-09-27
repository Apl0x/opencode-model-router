const { value01 } = require("./a01");

function value02(x) {
  return x * 2;
}

function label02() {
  return "a02";
}

function chained02(x) {
  return value01(x) + 2;
}

module.exports = { value02, label02, chained02 };
