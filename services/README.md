# WebTV service: minisrv

The Bridge connects the box to a WebTV service over WiFi. We use [zefie's minisrv](https://github.com/zefie/zefie_wtvp_minisrv) (GPL-3.0), tested at 0.9.75. It isn't vendored here; clone it into `services/minisrv` (the emulator's `tools/serve.mjs` starts it from there, and `src/machine/romfs.js` uses its LZPF/LZSS codecs):

```sh
git clone https://github.com/zefie/zefie_wtvp_minisrv services/minisrv
cd services/minisrv
git apply ../minisrv-no-ssl-certs.patch
npm install
node app.js
```

`minisrv-no-ssl-certs.patch` stops minisrv sending `wtv-ssl-certs-download-url` and `wtv-ssl-certs-checksum` at login. Each makes the OS's `RootList::Reset()` empty its list of SSL root certificates; until the first page has drawn, `RootList::Idle` asserts `strcmp(url, fResource.GetURL())==0`, and a debug build (16406) stops in its debugger right after `wtv-home:/splash`. Without the headers the box keeps its built-in roots. Production builds don't assert, so the patch matters only for debug builds.

Point the Bridge at the computer running minisrv: Settings → WTVP server on the TV, the Server Settings tab of the Bridge's web page, or `service <address>` on its USB console.
