const { value04 } = require("./a04");

function value08(x) {
  return x * 8;
}

function label08() {
  return "a08";
}

function chained08(x) {
  return value04(x) + 8;
}

module.exports = { value08, label08, chained08 };
