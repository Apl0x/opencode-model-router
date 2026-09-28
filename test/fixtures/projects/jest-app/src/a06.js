const { value03 } = require("./a03");

function value06(x) {
  return x * 6;
}

function label06() {
  return "a06";
}

function chained06(x) {
  return value03(x) + 6;
}

module.exports = { value06, label06, chained06 };
