#pragma once

#include <JavaScriptCore/CachedBytecode.h>
#include <JavaScriptCore/ParserModes.h>
#include <JavaScriptCore/SourceCode.h>
#include <JavaScriptCore/Weak.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/SentinelLinkedList.h>

namespace JSC {
class JSGlobalObject;
class ParserError;
class ProgramExecutable;
class UnlinkedProgramCodeBlock;
}
namespace Zig {
class GlobalObject;
}

namespace Bun {

// Only immutable source/payload bytes are owned. Decoded code is a weak shortcut: its lazy children may grow.
class NodeVMCompilationCache {
public:
    enum class Kind : uint8_t { Script,
        Function };
    struct Identity {
        int lineOffset;
        int columnOffset;
        Kind kind;
        bool filenameProvided;
        bool produceCachedData;
        OptionSet<JSC::CodeGenerationMode> codeGenerationMode;
        unsigned lexicalFeatures;
        friend bool operator==(const Identity&, const Identity&) = default;
    };
    struct Statistics {
        size_t limit { 0 };
        size_t admissionThreshold { 1750 };
        size_t observedSources { 0 };
        bool active { false };
        size_t bytes { 0 };
        size_t entries { 0 };
        uint64_t hits { 0 };
        uint64_t decodes { 0 };
        uint64_t misses { 0 };
        uint64_t evictions { 0 };
    };
    ~NodeVMCompilationCache();
    bool isActive() const { return m_statistics.active; }
    void observeCompilation(JSC::JSGlobalObject*, const JSC::SourceCode&, const Identity&, bool hasCachedData, JSC::UnlinkedProgramCodeBlock*);
    JSC::UnlinkedProgramCodeBlock* getOrCompile(JSC::JSGlobalObject*, JSC::ProgramExecutable*, const JSC::SourceCode&, const Identity&, bool hasCachedData, JSC::ParserError&);
    RefPtr<JSC::CachedBytecode> bytecode(const JSC::SourceCode&, const Identity&);
    const Statistics& statistics();

private:
    struct Entry : WTF::BasicRawSentinelNode<Entry> {
        unsigned hash;
        Identity identity;
        WTF::String source;
        WTF::String filename;
        JSC::Weak<JSC::JSCell> importer;
        bool hasImporter;
        bool fullBytecode { false };
        bool promotionAttempted { false };
        RefPtr<JSC::CachedBytecode> bytecode;
        JSC::Weak<JSC::UnlinkedProgramCodeBlock> decoded;
        size_t bytes;
    };
    using Entries = WTF::UncheckedKeyHashMap<unsigned, std::unique_ptr<Entry>>;
    WTF::UncheckedKeyHashSet<uint64_t> m_seenSources;
    Entries m_entries;
    WTF::SentinelLinkedList<Entry, WTF::BasicRawSentinelNode<Entry>> m_lru;
    Statistics m_statistics;
    bool m_initialized { false };
    void initialize();
    bool admit(const JSC::SourceCode&);
    Entry* find(const JSC::SourceCode&, const Identity&);
    void remove(Entry&);
    void insert(JSC::JSGlobalObject*, const JSC::SourceCode&, const Identity&, JSC::UnlinkedProgramCodeBlock*, bool fullBytecode);
};

JSC::JSValue createNodeVMCompilationCacheStatsForTesting(Zig::GlobalObject*);
}
