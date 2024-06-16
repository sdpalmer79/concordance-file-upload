const listeners = [];

module.exports = {
    registerHealthCheck: (name, func) => {
        listeners.push({name, func});
    },
    checkHealth: async () => {
        const results = await Promise.all(listeners.map(async (listener) => await listener.func()));
        return results.every(result => result === true);
    }
}
