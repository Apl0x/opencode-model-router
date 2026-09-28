const { value02 } = require("./a02");

function value04(x) {
  return x * 4;
}

function label04() {
  return "a04";
}

function chained04(x) {
  return value02(x) + 4;
}

module.exports = { value04, label04, chained04 };
