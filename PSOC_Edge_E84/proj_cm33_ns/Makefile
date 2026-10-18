################################################################################
# \file Makefile
# \version 1.0
#
# \brief
# Makefile for configuring the Cortex-M33 core project
#
################################################################################
# \copyright
# (c) 2024-2026, Infineon Technologies AG, or an affiliate of Infineon
# Technologies AG.  SPDX-License-Identifier: Apache-2.0
# 
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
# 
#     http://www.apache.org/licenses/LICENSE-2.0
# 
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
################################################################################

include ../common.mk

################################################################################
# Basic Configuration
################################################################################

# Name of application (used to derive name of final linked file).
#
# If APPNAME is edited, ensure to update or regenerate launch
# configurations for your IDE.
APPNAME=proj_cm33_ns

# If set to "true" or "1", display full command-lines when building.
VERBOSE=


################################################################################
# Advanced Configuration
################################################################################

# Enable optional code that is ordinarily disabled by default.
#
# Available components depend on the specific targeted hardware and firmware
# in use. In general, if you have
#
#    COMPONENTS=foo bar
#
# ... then code in directories named COMPONENT_foo and COMPONENT_bar will be
# added to the build
#
COMPONENTS+=FREERTOS LWIP MBEDTLS SECURE_SOCKETS

# Like COMPONENTS, but disable optional code that was enabled by default.
DISABLE_COMPONENTS=

CORE=CM33
CORE_NAME=CM33_0

# By default the build system automatically looks in the Makefile's directory
# tree for source code and builds it. The SOURCES variable can be used to
# manually add source code to the build process from a location not searched
# by default, or otherwise not found by the build system.
SOURCES+=../source/e84_shared.c ../source/e84_network.c ../source/e84_wifi_hw.c ../source/door_server.c ../source/door_clock.c ../source/wifi_settings.c ../source/wifi_reconnect.c ../source/audio_core.c ../source/audio_store.c ../source/m5_link.c ../source/m5_protocol.c
SOURCES+=../source/voice_protocol.c ../source/relay_protocol.c ../source/voice_transport.c ../source/voice_stream.c
SOURCES+=../source/socket_copy.c
LDFLAGS+=-Wl,--wrap=netconn_write_partly

# Like SOURCES, but for include directories. Value should be paths to
# directories (without a leading -I).
INCLUDES+=../source

# Custom configuration of mbedtls library.
MBEDTLSFLAGS = MBEDTLS_USER_CONFIG_FILE='"door_mbedtls_user_config.h"'

# Add additional defines to the build process (without a leading -D).
DEFINES+=E84_NETWORK_CORE
DEFINES+=$(MBEDTLSFLAGS) CYBSP_WIFI_CAPABLE CY_RETARGET_IO_CONVERT_LF_TO_CRLF CY_RTOS_AWARE 

# Default configuration of mbedtls library.
DEFINES+=MBEDTLS_CONFIG_FILE='"mbedtls/mbedtls_config.h"'

# PSA configuration of mbedtls library.
DEFINES+=MBEDTLS_PSA_CRYPTO_CONFIG_FILE='"configs/ifx_psa_crypto_config.h"'

# Define the following macro in the application's Makefile to mandatorily disable the custom 
# configuration header file.
DEFINES += HTTP_DO_NOT_USE_CUSTOM_CONFIG
DEFINES += MQTT_DO_NOT_USE_CUSTOM_CONFIG

# Select softfp or hardfp floating point. Default is softfp.
VFP_SELECT+=

# Additional / custom C compiler flags.
#
# NOTE: Includes and defines should use the INCLUDES and DEFINES variable
# above.
CFLAGS+=

# Additional / custom C++ compiler flags.
#
# NOTE: Includes and defines should use the INCLUDES and DEFINES variable
# above.
CXXFLAGS+=

# Additional / custom assembler flags.
#
# NOTE: Includes and defines should use the INCLUDES and DEFINES variable
# above.
ASFLAGS+=

# Additional / custom linker flags.
LDFLAGS+=-u _printf_float

# Additional / custom libraries to link in to the application.
LDLIBS+=

# Path to the linker script to use (if empty, use the default linker script).
LINKER_SCRIPT=

# Custom pre-build commands to run.
PREBUILD=

# Custom post-build commands to run.
POSTBUILD=

################################################################################
# Paths
################################################################################

# Relative path to the project directory (default is the Makefile's directory).
#
# This controls where automatic source code discovery looks for code.
CY_APP_PATH=

# Relative path to the shared repo location.
#
# All .mtb files have the format, <URI>#<COMMIT>#<LOCATION>. If the <LOCATION> 
# field begins with $$ASSET_REPO$$, then the repo is deposited in the path 
# specified by the CY_GETLIBS_SHARED_PATH variable. The default location is one 
# directory level above the current app directory.
# This is used with CY_GETLIBS_SHARED_NAME variable, which specifies the 
# directory name.
CY_GETLIBS_SHARED_PATH=..

# Directory name of the shared repo location.
#
CY_GETLIBS_SHARED_NAME=mtb_shared

include $(CY_TOOLS_DIR)/make/start.mk
