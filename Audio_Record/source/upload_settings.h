#pragma once
#include "door_root_ca.h"
#if __has_include("upload_config.h")
#include "upload_config.h"
#endif
#ifndef AUDIO_UPLOAD_HOST
#define AUDIO_UPLOAD_HOST ""
#endif
#ifndef AUDIO_UPLOAD_TOKEN
#define AUDIO_UPLOAD_TOKEN ""
#endif
#ifndef AUDIO_UPLOAD_CA_PEM
#define AUDIO_UPLOAD_CA_PEM DOOR_ROOT_CA_PEM
#endif
