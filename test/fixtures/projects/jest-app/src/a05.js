const { value02 } = require("./a02");

function value05(x) {
  return x * 5;
}

function label05() {
  return "a05";
}

function chained05(x) {
  return value02(x) + 5;
}

module.exports = { value05, label05, chained05 };
