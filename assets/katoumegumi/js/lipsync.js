(function () {
    var mouthOpen = 0;
    var originalLoadModel = window.Live2DModelWebGL.loadModel;

    window.setLive2dLipSyncValue = function (value) {
        mouthOpen = Math.max(0, Math.min(1, Number(value) || 0));
    };

    window.Live2DModelWebGL.loadModel = function (buffer) {
        var model = originalLoadModel.call(this, buffer);
        var originalUpdate = model.update.bind(model);
        model.update = function () {
            model.setParamFloat('PARAM_MOUTH_OPEN_Y', mouthOpen);
            return originalUpdate();
        };
        return model;
    };
})();
