const countdownState = {
    window: null,
    initialized: false,
    minimized: false,
    pollTimer: null,
    startupRetryTimer: null,
    firstSuccessLocked: false,
    latestItems: [],
    loading: false,
};

module.exports = {
    countdownState,
};
