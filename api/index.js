module.exports = function terminalxVercelHandler(req, res) {
  try {
    const { handleRequest } = require("../services/api/src/server");
    return handleRequest(req, res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify(
        {
          error: "terminalx_startup_failed",
          message: error.message,
          required: [
            "DATABASE_PROVIDER=postgres",
            "DATABASE_URL",
            "SESSION_SECRET",
            "ADMIN_EMAIL",
            "ADMIN_PASSWORD"
          ]
        },
        null,
        2
      )
    );
  }
};
