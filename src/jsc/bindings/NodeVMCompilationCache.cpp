#include "NodeVMCompilationCache.h"
#include "BunClientData.h"
#include "NodeVM.h"
#include "NodeVMScriptFetcher.h"
#include <JavaScriptCore/CodeCache.h>
#include <JavaScriptCore/BytecodeCacheError.h>
#include <wtf/FileHandle.h>
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/ProgramExecutable.h>
#include <JavaScriptCore/SourceCodeKey.h>
#include <JavaScriptCore/UnlinkedProgramCodeBlock.h>
#include <JavaScriptCore/WeakInlines.h>
#include <wtf/Hasher.h>
#include <charconv>
#include <cstdlib>

namespace Bun {

static constexpr size_t defaultLimit = 256 * 1024 * 1024;
// CodeCacheMap prunes at 2,000 entries; leave 250 slots for other JSC compilation users.
static constexpr size_t defaultAdmissionThreshold = 1750;
static constexpr size_t maxAdmissionThreshold = 2000;
// Per-entry reservation covers the entry, two StringImpls, weak handles, payload owner and hash-table slack.
static constexpr size_t entryOverhead = 1024;

static JSValue importerFor(const SourceCode& source)
{
    auto* fetcher = source.provider()->sourceOrigin().fetcher();
    if (fetcher && fetcher->fetcherType() == ScriptFetcher::Type::NodeVM)
        return static_cast<NodeVMScriptFetcher*>(fetcher)->dynamicImportCallback();
    return jsUndefined();
}

static unsigned cacheHash(const SourceCode& source, const NodeVMCompilationCache::Identity& identity)
{
    JSValue importer = importerFor(source);
    uintptr_t importerIdentity = importer.isCell() ? reinterpret_cast<uintptr_t>(importer.asCell()) : 0;
    unsigned hash = WTF::computeHash(importerIdentity, source.hash(), source.provider()->sourceURL(), identity.lineOffset, identity.columnOffset,
        static_cast<unsigned>(identity.kind), identity.filenameProvided, identity.produceCachedData, identity.codeGenerationMode.toRaw(), identity.lexicalFeatures);
    return 1 + (hash & 0x7ffffffe); // Reserve the HashMap's empty/deleted integer sentinels.
}

void NodeVMCompilationCache::initialize()
{
    if (m_initialized)
        return;
    m_initialized = true;
    m_statistics.limit = defaultLimit;
    if (const char* value = std::getenv("BUN_VM_COMPILE_CACHE_SIZE")) {
        size_t limit;
        const char* end = value + strlen(value);
        auto parsed = std::from_chars(value, end, limit);
        if (parsed.ec == std::errc() && parsed.ptr == end)
            m_statistics.limit = limit;
    }
    m_statistics.admissionThreshold = defaultAdmissionThreshold;
    if (const char* value = std::getenv("BUN_VM_COMPILE_CACHE_THRESHOLD")) {
        size_t threshold;
        const char* end = value + strlen(value);
        auto parsed = std::from_chars(value, end, threshold);
        if (parsed.ec == std::errc() && parsed.ptr == end && threshold <= maxAdmissionThreshold)
            m_statistics.admissionThreshold = threshold;
    }
    m_statistics.active = m_statistics.limit && !m_statistics.admissionThreshold;
}

bool NodeVMCompilationCache::admit(const SourceCode& source)
{
    if (m_statistics.active)
        return true;
    // JSC uses the same memoized source hash. Collisions can only postpone admission, never cause a cache hit.
    uint64_t fingerprint = (static_cast<uint64_t>(source.hash()) << 32) | source.length();
    m_seenSources.add(fingerprint + 1);
    m_statistics.observedSources = m_seenSources.size();
    if (m_statistics.observedSources <= m_statistics.admissionThreshold)
        return false;
    m_seenSources.clear();
    m_statistics.active = true;
    return true;
}

NodeVMCompilationCache::~NodeVMCompilationCache()
{
    while (!m_lru.isEmpty())
        remove(*m_lru.begin());
}

const NodeVMCompilationCache::Statistics& NodeVMCompilationCache::statistics()
{
    initialize();
    return m_statistics;
}

NodeVMCompilationCache::Entry* NodeVMCompilationCache::find(const SourceCode& source, const Identity& identity)
{
    initialize();
    if (!m_statistics.active || !identity.codeGenerationMode.isEmpty())
        return nullptr;
    auto it = m_entries.find(cacheHash(source, identity));
    if (it == m_entries.end())
        return nullptr;
    auto& entry = *it->value;
    JSValue importer = importerFor(source);
    if (!(entry.identity == identity) || entry.filename != source.provider()->sourceURL() || entry.source != source.view()
        || entry.hasImporter != importer.isCell() || (entry.hasImporter && entry.importer.get() != importer.asCell()))
        return nullptr;
    entry.remove();
    m_lru.append(&entry);
    return &entry;
}

void NodeVMCompilationCache::remove(Entry& entry)
{
    m_statistics.bytes -= entry.bytes;
    --m_statistics.entries;
    unsigned hash = entry.hash;
    entry.remove();
    m_entries.remove(hash);
}

void NodeVMCompilationCache::insert(JSGlobalObject* globalObject, const SourceCode& source, const Identity& identity, UnlinkedProgramCodeBlock* block, bool fullBytecode)
{
    const String& filename = source.provider()->sourceURL();
    size_t sourceBytes = source.length() * (source.view().is8Bit() ? size_t(1) : size_t(2));
    size_t filenameBytes = filename.length() * (filename.is8Bit() ? size_t(1) : size_t(2));
    size_t baseBytes = sourceBytes + filenameBytes + entryOverhead;
    if (baseBytes > m_statistics.limit)
        return;
    RefPtr<CachedBytecode> bytes;
    if (fullBytecode)
        bytes = NodeVM::getBytecode(globalObject, SourceCodeType::ProgramType, source);
    else {
        BytecodeCacheError error;
        FileSystem::FileHandle file;
        bytes = serializeBytecode(globalObject->vm(), block, source, SourceCodeType::ProgramType, static_cast<LexicallyScopedFeatures>(identity.lexicalFeatures), JSParserScriptMode::Classic, file, error, identity.codeGenerationMode);
    }
    if (!bytes || bytes->size() > m_statistics.limit - baseBytes)
        return;
    size_t charge = baseBytes + bytes->size();
    unsigned hash = cacheHash(source, identity);
    if (auto it = m_entries.find(hash); it != m_entries.end())
        remove(*it->value);
    while (m_statistics.bytes > m_statistics.limit - charge) {
        remove(*m_lru.begin());
        ++m_statistics.evictions;
    }
    auto entry = makeUnique<Entry>();
    entry->hash = hash;
    entry->identity = identity;
    entry->fullBytecode = fullBytecode;
    entry->promotionAttempted = fullBytecode;
    // Copy the exact slices: a substring must not keep a much larger parent string alive.
    entry->source = source.view().is8Bit() ? String(source.view().span8()) : String(source.view().span16());
    entry->filename = filename.is8Bit() ? String(filename.span8()) : String(filename.span16());
    JSValue importer = importerFor(source);
    entry->hasImporter = importer.isCell();
    if (entry->hasImporter)
        entry->importer = Weak<JSCell>(importer.asCell());
    // Drop the encoder's update/leaf maps; cached payloads never own growing decoded graphs.
    entry->bytecode = NodeVM::createOwnedCachedBytecode(bytes->span());
    entry->decoded = Weak<UnlinkedProgramCodeBlock>(block);
    entry->bytes = charge;
    m_lru.append(entry.get());
    m_entries.add(hash, WTF::move(entry));
    m_statistics.bytes += charge;
    ++m_statistics.entries;
}

void NodeVMCompilationCache::observeCompilation(JSGlobalObject* globalObject, const SourceCode& source, const Identity& identity, bool hasCachedData, UnlinkedProgramCodeBlock* block)
{
    initialize();
    if (!m_statistics.limit || hasCachedData || !identity.codeGenerationMode.isEmpty() || !admit(source))
        return;
    ++m_statistics.misses;
    Strong<UnlinkedProgramCodeBlock> protectedBlock(globalObject->vm(), block);
    insert(globalObject, source, identity, block, false);
}

UnlinkedProgramCodeBlock* NodeVMCompilationCache::getOrCompile(JSGlobalObject* globalObject, ProgramExecutable* executable, const SourceCode& source, const Identity& identity, bool hasCachedData, ParserError& error)
{
    initialize();
    VM& vm = globalObject->vm();
    bool enabled = m_statistics.limit && !hasCachedData && identity.codeGenerationMode.isEmpty();
    if (enabled) {
        if (auto* entry = find(source, identity)) {
            auto* block = entry->decoded.get();
            if (!block) {
                LexicallyScopedFeatures features = globalObject->globalScopeExtension() ? TaintedByWithScopeLexicallyScopedFeature : NoLexicallyScopedFeatures;
                SourceCodeKey key(source, {}, SourceCodeType::ProgramType, features, JSParserScriptMode::Classic, DerivedContextType::None, EvalContextType::None, false, identity.codeGenerationMode, std::nullopt);
                block = decodeCodeBlock<UnlinkedProgramCodeBlock>(vm, key, *entry->bytecode);
                if (block) {
                    entry->decoded = Weak<UnlinkedProgramCodeBlock>(block);
                    ++m_statistics.decodes;
                }
            }
            if (block) {
                if (!entry->promotionAttempted) {
                    entry->promotionAttempted = true;
                    Strong<UnlinkedProgramCodeBlock> protectedBlock(vm, block);
                    insert(globalObject, source, identity, block, true);
                }
                ++m_statistics.hits;
                recordParseFromUnlinkedCodeBlock(executable, source, block);
                return block;
            }
        }
        ++m_statistics.misses;
    }
    auto* block = vm.codeCache()->getUnlinkedProgramCodeBlock(vm, executable, source, identity.codeGenerationMode, error);
    if (block && enabled) {
        Strong<UnlinkedProgramCodeBlock> protectedBlock(vm, block);
        insert(globalObject, source, identity, block, false);
    }
    return block;
}

RefPtr<CachedBytecode> NodeVMCompilationCache::bytecode(const SourceCode& source, const Identity& identity)
{
    if (auto* entry = find(source, identity); entry && entry->fullBytecode)
        return entry->bytecode;
    return nullptr;
}

JSC_DEFINE_HOST_FUNCTION(nodeVMCompilationCacheStats, (JSGlobalObject * globalObject, CallFrame*))
{
    auto& vm = globalObject->vm();
    const auto& stats = WebCore::clientData(vm)->nodeVMCompilationCache.statistics();
    auto* result = constructEmptyObject(globalObject);
    Bun::putDirectNamed(vm, result, "limit"_s, jsNumber(stats.limit));
    Bun::putDirectNamed(vm, result, "admissionThreshold"_s, jsNumber(stats.admissionThreshold));
    Bun::putDirectNamed(vm, result, "observedSources"_s, jsNumber(stats.observedSources));
    Bun::putDirectNamed(vm, result, "active"_s, jsBoolean(stats.active));
    Bun::putDirectNamed(vm, result, "bytes"_s, jsNumber(stats.bytes));
    Bun::putDirectNamed(vm, result, "entries"_s, jsNumber(stats.entries));
    Bun::putDirectNamed(vm, result, "hits"_s, jsNumber(stats.hits));
    Bun::putDirectNamed(vm, result, "decodes"_s, jsNumber(stats.decodes));
    Bun::putDirectNamed(vm, result, "misses"_s, jsNumber(stats.misses));
    Bun::putDirectNamed(vm, result, "evictions"_s, jsNumber(stats.evictions));
    return JSValue::encode(result);
}

JSValue createNodeVMCompilationCacheStatsForTesting(Zig::GlobalObject* globalObject)
{
    return JSFunction::create(globalObject->vm(), globalObject, 0, "nodeVMCompilationCacheStats"_s, nodeVMCompilationCacheStats, ImplementationVisibility::Public);
}
}
