// Stands in for node:crypto inside the Bare worker: @noble/hashes imports it at
// load time, but we never ask noble for random bytes (sodium provides them).
module.exports = {}
