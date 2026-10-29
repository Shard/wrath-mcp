# Included inline by AzerothCore's modules/CMakeLists.txt (auto-discovered as
# modules/<name>/<name>.cmake). Stamps the build identity served on /health.
#
# WRATHBENCH_BUILD is whatever the builder passes as -DWRATHBENCH_BUILD=<id>
# (WrathBench's worldserver image passes its repository's `git describe --tags
# --always --dirty`). It is scoped to
# WbManager.cpp alone so a new describe string recompiles one translation unit,
# not the whole module, and leaves the rest of the ccache intact. Unset or
# empty: the module reports "unknown".
if(WRATHBENCH_BUILD)
  set_source_files_properties(
    "${CMAKE_SOURCE_DIR}/modules/mod-wrathbench/src/WbManager.cpp"
    PROPERTIES COMPILE_DEFINITIONS "WRATHBENCH_BUILD=\"${WRATHBENCH_BUILD}\"")
  message(STATUS "mod-wrathbench: build identity ${WRATHBENCH_BUILD}")
else()
  message(STATUS "mod-wrathbench: no WRATHBENCH_BUILD passed; /health reports build \"unknown\"")
endif()
