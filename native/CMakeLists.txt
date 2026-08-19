cmake_minimum_required(VERSION 3.20)
# C and OBJCXX are here for JUCE's sake: its modules compile Objective-C++ on
# macOS and it refuses to configure without a C compiler. The DSP itself is
# still plain C++17.
project(sigil_native VERSION 0.1.0 LANGUAGES C CXX)
if(APPLE)
  enable_language(OBJC)
  enable_language(OBJCXX)
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE RelWithDebInfo CACHE STRING "" FORCE)
endif()

# ---------------------------------------------------------------------------
# Floating-point settings. These are not style; parity depends on them.
#
#   -ffp-contract=off
#       Clang fuses `a + b*c` into a single fused multiply-add. Verified on this
#       toolchain (Apple clang 17, arm64): `-ffp-contract=fast` emits `fmadd`
#       where `off` emits `fmul` + `fadd`. FMA keeps the intermediate product at
#       full width, so it rounds once where JavaScript rounds twice - JS has no
#       FMA and rounds after every operation.
#
#       Honesty about the size of this: measured, building the five modules
#       ported so far with `-ffp-contract=fast` changed NO golden - 31/31 still
#       passed. One contraction is worth about 1 ulp of double (2e-16 relative),
#       and the goldens are stored as float32 (6e-8 resolution), so in a filter
#       with a modest pole it disappears entirely.
#
#       It is off anyway, for two reasons. It costs nothing to disable, and the
#       places where it stops being invisible are exactly the places this synth
#       lives: long high-Q tails and FDN reverbs where error amplifies over tens
#       of thousands of samples, and the many comparison thresholds in this code
#       (`if (this.acc >= 1)`, envelope stage flips, stutter latching) where a
#       1-ulp difference decides a branch and moves a transition by a whole
#       sample. Do not turn it on to chase performance.
#
#   no -ffast-math / -Ofast
#       Those imply -ffinite-math-only (breaks the NaN guards, which are
#       load-bearing here: `if (!(y > -4 && y < 4))` is DESIGNED to catch NaN)
#       and -fno-signed-zeros, and on Apple platforms they link a startup stub
#       that sets FTZ/DAZ. The TypeScript flushes denormals explicitly, by hand,
#       at specific points; hardware flushing would flush at different points
#       and diverge. If a future build adds -Ofast, parity is gone.
# ---------------------------------------------------------------------------
add_compile_options(-ffp-contract=off)
add_compile_options(-Wall -Wextra)

foreach(flags IN ITEMS "${CMAKE_CXX_FLAGS}" "${CMAKE_CXX_FLAGS_RELEASE}"
                       "${CMAKE_CXX_FLAGS_RELWITHDEBINFO}")
  if(flags MATCHES "-ffast-math|-Ofast|-ffinite-math-only|-funsafe-math-optimizations")
    message(FATAL_ERROR
      "Unsafe math flags detected (${flags}). They break bit-parity with the "
      "TypeScript reference. Remove them.")
  endif()
endforeach()

# ---------------------------------------------------------------------------
# The DSP. Header-only for now, so the parity rig and the future VST3 wrapper
# share exactly one copy of the code.
# ---------------------------------------------------------------------------
add_library(sigil_dsp INTERFACE)
target_include_directories(sigil_dsp INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/src)

file(GLOB SIGIL_DSP_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/dsp/*.cpp)
if(SIGIL_DSP_SOURCES)
  add_library(sigil_dsp_obj STATIC ${SIGIL_DSP_SOURCES})
  target_include_directories(sigil_dsp_obj PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
  target_link_libraries(sigil_dsp INTERFACE sigil_dsp_obj)
endif()

# ---------------------------------------------------------------------------
# Parity rig.
#
# Case runners are compiled straight into the executable rather than into a
# static library: they register themselves from static initialisers, and a
# linker is entitled to drop an object file from an archive when nothing
# references it. Linked directly, they cannot be dropped.
# ---------------------------------------------------------------------------
file(GLOB PARITY_CASE_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/test/cases/*.cpp)

add_executable(sigil_parity
  ${CMAKE_CURRENT_SOURCE_DIR}/test/parity.cpp
  ${PARITY_CASE_SOURCES}
)
target_link_libraries(sigil_parity PRIVATE sigil_dsp)
target_compile_definitions(sigil_parity PRIVATE
  SIGIL_GOLDENS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/goldens")

# ---------------------------------------------------------------------------
# Descriptor cross-check: generated table vs the hand-ported DSP constants.
# ---------------------------------------------------------------------------
add_executable(sigil_descriptor_check
  ${CMAKE_CURRENT_SOURCE_DIR}/test/descriptor_check.cpp)
target_link_libraries(sigil_descriptor_check PRIVATE sigil_dsp)

enable_testing()
add_test(NAME parity COMMAND sigil_parity)
add_test(NAME descriptors COMMAND sigil_descriptor_check)

# `ctest -R parity_strict` fails on anything not yet ported. Enabled now that
# every module has a runner: 197 of 197 cases pass, so an unimplemented case
# appearing again is a regression, not work in progress.
add_test(NAME parity_strict COMMAND sigil_parity --strict)

# ---------------------------------------------------------------------------
# VST3 plugin.
#
# VST3 ONLY, on purpose. This machine has Command Line Tools rather than a full
# Xcode install, and JUCE's AudioUnit client needs Xcode's AU tooling, so an AU
# target here would fail at build time. Say so rather than half-attempting it.
#
# Off by default so the parity rig still configures on a machine without JUCE.
#   cmake -S native -B native/build -DSIGIL_BUILD_PLUGIN=ON
# ---------------------------------------------------------------------------
option(SIGIL_BUILD_PLUGIN "Build the SIGIL VST3 plugin (requires JUCE)" OFF)
set(SIGIL_JUCE_DIR "$ENV{HOME}/JUCE" CACHE PATH "Path to a JUCE checkout")

if(SIGIL_BUILD_PLUGIN)
  if(NOT EXISTS "${SIGIL_JUCE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "SIGIL_BUILD_PLUGIN=ON but no JUCE at ${SIGIL_JUCE_DIR}")
  endif()

  add_subdirectory("${SIGIL_JUCE_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/juce" EXCLUDE_FROM_ALL)

  juce_add_plugin(SIGIL
    COMPANY_NAME "Sigil"
    BUNDLE_ID "com.sigil.sigil"
    PLUGIN_MANUFACTURER_CODE Sgil
    PLUGIN_CODE Sgl1
    # VST3 and Standalone. NOT AudioUnit: JUCE's AU client needs the AU tooling
    # that only ships with a full Xcode install, and this machine has Command
    # Line Tools, so an AU target would fail at build time. Standalone is a
    # plain .app and needs none of that - it is how the interface and the bridge
    # get looked at and listened to without a DAW in the loop.
    FORMATS VST3 Standalone
    PRODUCT_NAME "SIGIL"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    # The on-screen keyboard emits MIDI so a DAW can record what you play on it.
    # Without this a note played in SIGIL's own interface sounded but reached the
    # host as nothing, so an armed track recorded an empty clip.
    NEEDS_MIDI_OUTPUT TRUE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD FALSE
    VST3_CATEGORIES "Instrument" "Synth")

  # The interface is the real Next app, statically exported and compiled in.
  # `pnpm run build:plugin-ui` writes plugin/ui-bundle.cpp; it is generated, it
  # is large, and it is not in the repository, so configuring without it is a
  # clear error here rather than a confusing link failure later.
  set(SIGIL_UI_BUNDLE ${CMAKE_CURRENT_SOURCE_DIR}/plugin/ui-bundle.cpp)
  if(NOT EXISTS "${SIGIL_UI_BUNDLE}")
    message(FATAL_ERROR
      "plugin/ui-bundle.cpp is missing. Run `pnpm run build:plugin-ui` from the "
      "repository root to build and embed the interface, then configure again.")
  endif()

  target_sources(SIGIL PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/plugin/PluginProcessor.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/plugin/PluginEditor.cpp
    ${SIGIL_UI_BUNDLE})

  target_compile_features(SIGIL PRIVATE cxx_std_17)

  # JUCE's recommended warning set fires on the DSP headers for two things that
  # are DELIBERATE there and must not be "fixed": exact float comparisons (the
  # TypeScript uses ===, and a rewritten comparison is a DIFFERENT program) and
  # int-to-size_t indexing. The DSP already builds warning-clean under
  # -Wall -Wextra in the parity rig, so only these two are relaxed, and via an
  # INTERFACE target linked AFTER juce_recommended_warning_flags - a target's own
  # compile options are emitted BEFORE any interface options, so a plain
  # target_compile_options here would be overridden by the very flags it means
  # to relax.
  add_library(sigil_warning_relax INTERFACE)
  target_compile_options(sigil_warning_relax INTERFACE -Wno-float-equal -Wno-sign-conversion)

  target_compile_definitions(SIGIL PUBLIC
    # On, because the editor IS a WebBrowserComponent. Everything it loads comes
    # from the compiled-in resource provider, so the plugin still never touches
    # the network - a plugin that needs the internet is not a plugin.
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    # Off, or JUCE publishes 16 x 130 MIDI-CC parameters alongside the real
    # ones. Measured: with it on the host sees 2240 parameters, of which 2080
    # are CC stand-ins that Ableton would list in every automation menu. SIGIL
    # does not respond to CC, so they are noise.
    JUCE_VST3_EMULATE_MIDI_CC_WITH_PARAMETERS=0
    JUCE_REPORT_APP_USAGE=0)

  target_link_libraries(SIGIL
    PRIVATE
      sigil_dsp
      juce::juce_audio_utils
      juce::juce_gui_extra
    PUBLIC
      juce::juce_recommended_config_flags
      juce::juce_recommended_lto_flags
      juce::juce_recommended_warning_flags
      sigil_warning_relax)

  # -------------------------------------------------------------------------
  # Host check: loads the BUILT .vst3 through JUCE's VST3 host and plays it.
  # -------------------------------------------------------------------------
  juce_add_console_app(sigil_host_check PRODUCT_NAME "sigil_host_check")
  target_sources(sigil_host_check PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/tools/host_check.cpp)
  target_compile_definitions(sigil_host_check PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_VST=0
    JUCE_PLUGINHOST_AU=0
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_REPORT_APP_USAGE=0)
  target_include_directories(sigil_host_check PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
  target_link_libraries(sigil_host_check PRIVATE
    sigil_dsp
    sigil_warning_relax
    juce::juce_audio_utils
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

  # -------------------------------------------------------------------------
  # State check: the patch format rules, at processor level. Links the plugin's
  # own shared code, so it tests the same class the VST3 wraps.
  # -------------------------------------------------------------------------
  juce_add_console_app(sigil_state_check PRODUCT_NAME "sigil_state_check")
  target_sources(sigil_state_check PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/tools/state_check.cpp)
  target_include_directories(sigil_state_check PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
  # Must AGREE with SIGIL's PUBLIC definitions, which this target inherits by
  # linking it. Two different values for JUCE_WEB_BROWSER across translation
  # units of the same binary is an ODR violation waiting to bite.
  target_compile_definitions(sigil_state_check PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_REPORT_APP_USAGE=0)
  # A console app that links the plugin's shared code inherits the plugin's
  # JUCE_STANDALONE_APPLICATION definition alongside its own, which is harmless
  # and noisy. juce_recommended_warning_flags is not repeated here because
  # SIGIL already carries it PUBLIC-ly, and repeating it would order it after
  # the relaxations and undo them.
  target_compile_options(sigil_state_check PRIVATE -Wno-macro-redefined)
  target_link_libraries(sigil_state_check PRIVATE
    SIGIL
    sigil_dsp
    juce::juce_audio_utils
    juce::juce_recommended_config_flags
    sigil_warning_relax)

  add_test(NAME plugin_state COMMAND sigil_state_check)
  add_test(NAME plugin_host
    COMMAND sigil_host_check $<TARGET_BUNDLE_DIR:SIGIL_VST3>)
endif()
