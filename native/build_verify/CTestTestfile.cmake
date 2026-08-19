# CMake generated Testfile for 
# Source directory: /Users/naram/dev/sigil/native
# Build directory: /Users/naram/dev/sigil/native/build_verify
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test("parity" "/Users/naram/dev/sigil/native/build_verify/sigil_parity")
set_tests_properties("parity" PROPERTIES  _BACKTRACE_TRIPLES "/Users/naram/dev/sigil/native/CMakeLists.txt;89;add_test;/Users/naram/dev/sigil/native/CMakeLists.txt;0;")
add_test("parity_strict" "/Users/naram/dev/sigil/native/build_verify/sigil_parity" "--strict")
set_tests_properties("parity_strict" PROPERTIES  DISABLED "TRUE" _BACKTRACE_TRIPLES "/Users/naram/dev/sigil/native/CMakeLists.txt;93;add_test;/Users/naram/dev/sigil/native/CMakeLists.txt;0;")
