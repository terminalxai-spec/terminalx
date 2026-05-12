const { handleRequest } = require("../services/api/src/server");

module.exports = function terminalxVercelHandler(req, res) {
  return handleRequest(req, res);
};
