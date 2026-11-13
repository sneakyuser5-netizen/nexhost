const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/auth");
const support = require("../controllers/support.controller");

router.use(authenticate);

router.post("/", support.createTicket);
router.get("/", support.listTickets);
router.get("/:id", support.getTicket);
router.post("/:id/replies", support.replyTicket);
router.patch("/:id/status", support.updateTicketStatus);

module.exports = router;
