#pragma once

#include <JavaScriptCore/CachedBytecode.h>
#include <JavaScriptCore/ParserModes.h>
#include <JavaScriptCore/SourceCode.h>
#include <JavaScriptCore/Weak.h>
#include <wtf/FastMalloc.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/Vector.h>

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
    JSC::UnlinkedProgramCodeBlock* getOrCompile(JSC::JSGlobalObject*, JSC::ProgramExecutable*&, JSC::SourceCode&, const Identity&, bool hasCachedData, JSC::ParserError&);
    RefPtr<JSC::CachedBytecode> bytecode(const JSC::SourceCode&, const Identity&);
    const Statistics& statistics();
    static JSC::JSValue testPolicy(JSC::JSGlobalObject*);

private:
    enum class Promotion : uint8_t { None,
        Snapshot,
        Full };
    struct Entry {
        WTF_DEPRECATED_MAKE_STRUCT_FAST_ALLOCATED(Entry);
        unsigned hash;
        Identity identity;
        WTF::String source;
        WTF::String filename;
        JSC::Weak<JSC::JSCell> importer;
        bool hasImporter;
        bool fullBytecode { false };
        bool hasUncachedFunctions { false };
        Promotion promotionAttempted { Promotion::None };
        RefPtr<JSC::CachedBytecode> bytecode;
        JSC::Weak<JSC::UnlinkedProgramCodeBlock> decoded;
        size_t bytes;
        double rebuildCost { 0 };
        double priority { 0 };
        uint64_t lastAccess { 0 };
        size_t heapIndex { 0 };
    };
    using Entries = WTF::UncheckedKeyHashMap<unsigned, std::unique_ptr<Entry>>;
    WTF::UncheckedKeyHashSet<uint64_t> m_seenSources;
    Entries m_entries;
    WTF::Vector<Entry*> m_heap;
    double m_age { 0 };
    uint64_t m_access { 0 };
    Statistics m_statistics;
    bool m_initialized { false };
    void initialize();
    bool admit(const JSC::SourceCode&);
    Entry* find(const JSC::SourceCode&, const Identity&);
    void remove(Entry&);
    static bool precedes(const Entry&, const Entry&);
    void swapEntries(size_t, size_t);
    void siftUp(size_t);
    void siftDown(size_t);
    void touch(Entry&);
    void append(Entry&);
    void evictForSize(size_t);
    void insert(JSC::JSGlobalObject*, const JSC::SourceCode&, const Identity&, JSC::UnlinkedProgramCodeBlock*, Promotion, WTF::String sharedSource = {}, double compileCost = 0);
};

JSC::JSValue createNodeVMCompilationCacheStatsForTesting(Zig::GlobalObject*);
JSC::JSValue createNodeVMCompilationCachePolicyTest(Zig::GlobalObject*);
}
