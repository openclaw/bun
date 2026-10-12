#pragma once

#include "root.h"
#include "BunString.h"

namespace Bun {
void configureAOT();
void registerAOT();
void attachAOTSource(JSC::VM&, JSC::SourceProvider&, bool isModule);
}

struct BunAOTSource {
    BunString source;
    BunString name;
    uint32_t graphIndex;
};
