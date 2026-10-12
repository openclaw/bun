#include "root.h"
#include "BunAOT.h"
#include "ZigSourceProvider.h"
#include <JavaScriptCore/AOTProgramData.h>
#include <JavaScriptCore/CachedTypes.h>
#include <JavaScriptCore/Completion.h>
#include <JavaScriptCore/CodeCache.h>
#include <JavaScriptCore/ParserError.h>
#include <JavaScriptCore/SourceCodeKey.h>
#if OS(DARWIN)
#include <mach-o/dyld.h>
#include <mach-o/getsect.h>
#include <fcntl.h>
#include <unistd.h>
#endif

extern "C" bool Bun__standaloneAOTImage(const uint8_t**, size_t*);
extern "C" uint32_t Bun__standaloneAOTModuleID(const uint8_t*, size_t);
namespace Zig {
JSC::VM& vmForBytecodeCache();
}

namespace Bun {

static bool aotDisabled()
{
    const char* value = getenv("BUN_AOT_DISABLE");
    return value && !strcmp(value, "1");
}

void configureAOT()
{
    JSC::Options::useAOTFunctionSource() = true;
    if (const char* options = getenv("BUN_AOT_OPTIONS")) {
        for (auto option : String::fromUTF8(options).split(',')) {
            if (!JSC::Options::setOption(reinterpret_cast<const char*>(option.utf8().data()))) {
                fprintf(stderr, "Invalid BUN_AOT_OPTIONS option: %s\n", reinterpret_cast<const char*>(option.utf8().data()));
                exit(1);
            }
        }
    }
    const uint8_t* bytes = nullptr;
    size_t size = 0;
    if (Bun__standaloneAOTImage(&bytes, &size)) {
#if OS(DARWIN)
        // Like the JSC shell, this CLI can use Mach exceptions even when the JIT is off.
        if (JSC::Options::machExceptionHandlerSandboxPolicy == JSC::Options::SandboxPolicy::Unknown)
            JSC::Options::machExceptionHandlerSandboxPolicy = JSC::Options::SandboxPolicy::Allow;
#endif
        JSC::Options::useJIT() = false;
        JSC::Options::useAOT() = !aotDisabled();
        if (aotDisabled())
            JSC::Options::useImmutableIntrinsics() = false;
    }
}

void registerAOT()
{
    const uint8_t* bytes = nullptr;
    size_t size = 0;
    if (!Bun__standaloneAOTImage(&bytes, &size) || aotDisabled())
        return;
#if ENABLE(AOT) && OS(DARWIN)
    const segment_command_64* segment = nullptr;
    auto* header = reinterpret_cast<const mach_header_64*>(_dyld_get_image_header(0));
    auto* command = reinterpret_cast<const load_command*>(header + 1);
    for (uint32_t i = 0; i < header->ncmds; ++i) {
        if (command->cmd == LC_SEGMENT_64) {
            auto* candidate = reinterpret_cast<const segment_command_64*>(command);
            if (!strncmp(candidate->segname, "__BUN", sizeof(candidate->segname))) {
                segment = candidate;
                break;
            }
        }
        command = reinterpret_cast<const load_command*>(reinterpret_cast<const uint8_t*>(command) + command->cmdsize);
    }
    uintptr_t start = segment ? segment->vmaddr + _dyld_get_image_vmaddr_slide(0) : 0;
    if (!segment || reinterpret_cast<uintptr_t>(bytes) < start || size > segment->filesize || reinterpret_cast<uintptr_t>(bytes) - start > segment->filesize - size) {
        fprintf(stderr, "AOT image is outside the executable section\n");
        exit(1);
    }
    int fd = open(_dyld_get_image_name(0), O_RDONLY | O_CLOEXEC);
    auto use = JSC::useAOTFile({ bytes, size }, fd, segment->fileoff + reinterpret_cast<uintptr_t>(bytes) - start);
    if (fd >= 0)
        close(fd);
    if (use.imageRejectionReason || use.programDataRejectionReason) {
        fprintf(stderr, "Cannot register AOT image: %s\n", use.imageRejectionReason ? use.imageRejectionReason : use.programDataRejectionReason);
        exit(1);
    }
    if (getenv("BUN_AOT_STATS"))
        fprintf(stderr, "AOT: mapped %zu code bytes, %u image functions, JIT off\n", use.codeSizeInBytes, JSC::AOT::ProgramData::get()->numberOfFunctions);
#else
    fprintf(stderr, "AOT executable mapping is only implemented on macOS\n");
    exit(1);
#endif
}

void attachAOTSource(JSC::VM& vm, JSC::SourceProvider& provider, bool isModule)
{
#if ENABLE(AOT)
    const auto* data = JSC::AOT::ProgramData::get();
    if (!data)
        return;
    JSC::SourceCode source(Ref { provider });
    auto key = isModule ? JSC::sourceCodeKeyForSerializedModule(vm, source) : JSC::sourceCodeKeyForSerializedProgram(vm, source);
    auto name = provider.sourceURL().utf8();
    uint32_t moduleID = Bun__standaloneAOTModuleID(reinterpret_cast<const uint8_t*>(name.data()), name.length());
    const auto* module = moduleID ? data->moduleWithEntryOffset(moduleID - 1) : nullptr;
    if (!module || module->isBuiltinFunction || key.length() != module->keyLength || key.hash() != module->keyHash || key.flagsBits() != module->keyFlags)
        return;
    provider.setHasNoSourceText();
    provider.setAOTModuleID(moduleID);
    if (getenv("BUN_AOT_STATS"))
        fprintf(stderr, "AOT: registered module %s\n", reinterpret_cast<const char*>(name.data()));
#endif
}
}

extern "C" bool Bun__buildAOTImage(const BunAOTSource* sources, size_t count, bool isModule,
    const uint8_t* graphBytes, size_t graphSize, const uint8_t* tableBytes, size_t tableSize,
    const uint8_t* slotsBytes, size_t slotsSize, void* context, void (*append)(void*, const uint8_t*, size_t))
{
#if ENABLE(AOT)
    auto& vm = Zig::vmForBytecodeCache();
    JSC::JSLockHolder lock(vm);
    JSC::DeferGC deferGC(vm);
    auto& options = vm.bytecodeGenerationOptions;
    options.resolveAllScopeSlotsStatically = true;
    options.evaluateObjectLiteralValuesFirst = true;
    options.definePlainInstanceFieldsInConstructor = true;
    options.keepAllSourceLineStarts = true;
    vm.useImmutableIntrinsics = true;
    JSC::EncoderStringTable strings;
    Vector<uint32_t> slots;
    if (graphSize && tableSize && slotsSize >= sizeof(uint32_t)) {
        JSC::DecoderStringTable oldStrings({ tableBytes, tableSize });
        uint32_t slotCount;
        memcpy(&slotCount, slotsBytes, sizeof(slotCount));
        if (slotCount > (slotsSize - sizeof(uint32_t)) / sizeof(uint32_t))
            return false;
        for (uint32_t i = 0; i < slotCount; ++i) {
            uint32_t slot;
            memcpy(&slot, slotsBytes + (i + 1) * sizeof(uint32_t), sizeof(slot));
            auto atom = oldStrings.atomForSlot(vm, slot);
            if (!atom)
                return false;
            slots.append(strings.slotFor(*atom));
        }
    }
    JSC::BytecodeLinkEncoder::Hints hints;
    hints.compileAheadOfTime = true;
    JSC::BytecodeLinkEncoder encoder(vm, &strings, WTF::move(hints));
    Vector<uint32_t> graphIndices;
    for (size_t i = 0; i < count; ++i) {
        auto text = sources[i].source.toWTFString();
        auto name = sources[i].name.toWTFString();
        auto source = JSC::makeSource(text, Zig::toSourceOrigin(name, false), JSC::SourceTaintedOrigin::Untainted, name);
        JSC::ParserError error;
        JSC::UnlinkedCodeBlock* block = isModule
            ? static_cast<JSC::UnlinkedCodeBlock*>(JSC::recursivelyGenerateUnlinkedCodeBlockForModuleProgram(vm, source, JSC::StrictModeLexicallyScopedFeature, JSC::JSParserScriptMode::Module, {}, error, JSC::EvalContextType::None))
            : static_cast<JSC::UnlinkedCodeBlock*>(JSC::recursivelyGenerateUnlinkedCodeBlockForProgram(vm, source, JSC::NoLexicallyScopedFeatures, JSC::JSParserScriptMode::Classic, {}, error, JSC::EvalContextType::None));
        if (!block || error.isValid()) {
            fprintf(stderr, "Cannot parse AOT module: %s\n", reinterpret_cast<const char*>(name.utf8().data()));
            return false;
        }
        encoder.addModule(isModule ? JSC::sourceCodeKeyForSerializedModule(vm, source) : JSC::sourceCodeKeyForSerializedProgram(vm, source), block, source, {});
        graphIndices.append(sources[i].graphIndex);
    }
    if (graphSize && !slots.isEmpty())
        encoder.setPrelinkedModuleGraph({ graphBytes, graphSize }, slots.span(), WTF::move(graphIndices));
    auto linked = encoder.finish();
    auto imageSize = JSC::aotImageSize(linked.aotImage.span());
    if (!linked.payload || !imageSize || linked.entryOffsets.size() != count)
        return false;
    JSC::AOT::ProgramData::RetainedPositions positions { linked.reportableSites, [](uint32_t, JSC::LineColumn, WTF::UTF8CString&, JSC::LineColumn&) { return false; } };
    auto data = JSC::AOT::ProgramData::build(vm, strings.serialize().span(), linked.payload->span(), linked.moduleEntryOffsets.span(), linked.aotImage.span(), positions, linked.reportableSites.span(), linked.variablesExportedByModules.span());
    if (data.isEmpty())
        return false;
    append(context, linked.aotImage.span().data(), *imageSize);
    append(context, data.span().data(), data.size());
    // The manifest preserves identity when separate modules have identical source text.
    uint32_t moduleCount = WTF::safeCast<uint32_t>(count);
    append(context, reinterpret_cast<const uint8_t*>(&moduleCount), sizeof(moduleCount));
    for (size_t i = 0; i < count; ++i) {
        auto name = sources[i].name.toWTFString().utf8();
        uint32_t length = WTF::safeCast<uint32_t>(name.length());
        uint32_t id = linked.entryOffsets[i] + 1;
        append(context, reinterpret_cast<const uint8_t*>(&length), sizeof(length));
        append(context, reinterpret_cast<const uint8_t*>(name.data()), length);
        append(context, reinterpret_cast<const uint8_t*>(&id), sizeof(id));
    }
    uint64_t nativeSize = *imageSize + data.size();
    append(context, reinterpret_cast<const uint8_t*>(&nativeSize), sizeof(nativeSize));
    return true;
#else
    return false;
#endif
}
