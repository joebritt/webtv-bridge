# LPT modem bridge firmware for the Raspberry Pi Pico 2 W (WEBTV_LPT_BRIDGE.md).
#   cmake -B build -G Ninja -DPICO_SDK_PATH=/path/to/pico-sdk   (or PICO_SDK_FETCH_FROM_GIT=1)
#   ninja -C build              -> build/lptbridge.uf2
cmake_minimum_required(VERSION 3.13)

set(PICO_BOARD pico2_w CACHE STRING "Board type")
include(pico_sdk_import.cmake)

project(lptbridge C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

# src/gen comes from `node tools/picogen.mjs` (the loader, stage 0, the tier-3 image and the
# patch table, which sb_patches.S pulls in with .incbin from that directory)
add_executable(lptbridge
    src/main_pico.c
    src/net_lwip.c
    src/scanlist.c
    src/link.c
    src/port.c
    src/portglue.c
    src/web.c
    src/modem.c
    src/ppp.c
    src/gw.c
    src/bridge.c
    src/settings.c
    src/console.c
    src/log.c
    src/sb/sb_font.c
    src/sb/sb_ir.c
    src/sb/sb_patch.c
    src/sb/sb_proto.c
    src/sb/sb_ramboot.c
    src/sb/sb_session.c
    src/sb/sb_startup.c
    src/sb/sb_tier3.c
    src/sb/sb_ui.c
    src/gen/sb_assets.c
    src/gen/web_page.c
    src/gen/sb_patches.S
)
set_source_files_properties(src/gen/sb_patches.S PROPERTIES
    COMPILE_OPTIONS "-Wa,-I${CMAKE_CURRENT_SOURCE_DIR}/src/gen"
    OBJECT_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/gen/sb_patches.bin)
target_include_directories(lptbridge PRIVATE src)
target_compile_options(lptbridge PRIVATE -Wall -Wno-unused-parameter)
target_compile_definitions(lptbridge PRIVATE
    # the console UART's pins depend on the board revision; main() sets it up after link_init()
    PICO_STACK_SIZE=0x1000    # all of SCRATCH_Y; big buffers are static
    # core 1 (the link engine) never touches flash, so saving settings needn't stop it
    PICO_FLASH_ASSUME_CORE1_SAFE=1
    CYW43_HOST_NAME=\"webtv-bridge\"
)
target_link_libraries(lptbridge
    pico_stdlib
    pico_multicore
    pico_flash
    pico_cyw43_arch_lwip_poll
    hardware_flash
    hardware_watchdog
    hardware_pio
)
pico_enable_stdio_usb(lptbridge 1)
pico_enable_stdio_uart(lptbridge 1)
pico_add_extra_outputs(lptbridge)
