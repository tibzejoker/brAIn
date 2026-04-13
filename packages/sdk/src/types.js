"use strict";
// === Enums ===
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAILBOX_CONFIG = exports.AuthorityLevel = exports.NodeState = void 0;
var NodeState;
(function (NodeState) {
    NodeState["ACTIVE"] = "active";
    NodeState["SLEEPING"] = "sleeping";
    NodeState["STOPPED"] = "stopped";
    NodeState["TERMINATED"] = "terminated";
})(NodeState || (exports.NodeState = NodeState = {}));
var AuthorityLevel;
(function (AuthorityLevel) {
    AuthorityLevel[AuthorityLevel["BASIC"] = 0] = "BASIC";
    AuthorityLevel[AuthorityLevel["ELEVATED"] = 1] = "ELEVATED";
    AuthorityLevel[AuthorityLevel["ROOT"] = 2] = "ROOT";
})(AuthorityLevel || (exports.AuthorityLevel = AuthorityLevel = {}));
exports.DEFAULT_MAILBOX_CONFIG = {
    max_size: 100,
    retention: "latest",
};
//# sourceMappingURL=types.js.map