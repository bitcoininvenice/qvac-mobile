// The QVAC SDK plugin declares <uses-native-library android:name="libOpenCL.so"/> without
// android:required, i.e. as required: Android then refuses to install the app on every device
// that does not expose OpenCL (emulators, and many phones such as Pixels).
// Here it becomes optional: where OpenCL exists it is used, elsewhere QVAC runs on the CPU.
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withOptionalOpenCL(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (!app) return config;
    const libs = (app['uses-native-library'] = app['uses-native-library'] || []);
    const opencl = libs.find((lib) => lib.$['android:name'] === 'libOpenCL.so');
    if (opencl) opencl.$['android:required'] = 'false';
    else libs.push({ $: { 'android:name': 'libOpenCL.so', 'android:required': 'false' } });
    return config;
  });
};
