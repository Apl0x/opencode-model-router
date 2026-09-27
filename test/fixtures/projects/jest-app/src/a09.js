const { value04 } = require("./a04");

function value09(x) {
  return x * 9;
}

function label09() {
  return "a09";
}

function chained09(x) {
  return value04(x) + 9;
}

module.exports = { value09, label09, chained09 };
