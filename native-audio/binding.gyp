{
  "targets": [
    {
      "target_name": "native_audio",
      "sources": [ "src/audio_capture.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      },
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "libraries": [
        "Mmdevapi.lib",
        "uuid.lib",
        "ole32.lib",
        "user32.lib",
        "avrt.lib"
      ]
    }
  ]
}
