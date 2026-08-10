cmake_minimum_required(VERSION 3.15)

project(xunlei-download-host LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(xunlei-dlsdk-cpp CONFIG REQUIRED)

add_executable(xunlei-download-host main.cpp)
target_link_libraries(xunlei-download-host PRIVATE xunlei::dlsdk)

if (WIN32)
  set_target_properties(xunlei-download-host PROPERTIES WIN32_EXECUTABLE FALSE)
endif()
