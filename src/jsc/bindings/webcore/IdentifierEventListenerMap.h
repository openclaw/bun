#pragma once

#include <atomic>
#include <memory>
#include <wtf/Forward.h>
#include <wtf/Lock.h>
#include <wtf/Ref.h>
#include <JavaScriptCore/Identifier.h>
#include <JavaScriptCore/MarkedVector.h>
#include <JavaScriptCore/StrongInlines.h>
#include <JavaScriptCore/WriteBarrier.h>
#include "EventListener.h"

namespace WebCore {

class SimpleRegisteredEventListener : public RefCounted<SimpleRegisteredEventListener> {
public:
    static Ref<SimpleRegisteredEventListener> create(Ref<EventListener>&& listener, bool once)
    {
        return adoptRef(*new SimpleRegisteredEventListener(WTF::move(listener), once));
    }

    EventListener& callback() const { return m_callback; }
    bool isOnce() const { return m_isOnce; }
    bool wasRemoved() const { return m_wasRemoved; }
    bool hasFired() const { return m_hasFired; }
    void markAsFired() { m_hasFired = true; }

    void markAsRemoved() { m_wasRemoved = true; }

    JSC::JSObject* onceWrapper() const { return m_onceWrapper.get(); }
    void setOnceWrapper(JSC::VM& vm, JSC::JSCell* owner, JSC::JSObject* wrapper)
    {
        m_onceWrapper.set(vm, owner, wrapper);
        if (m_activeDispatchCount)
            m_dispatchOnceWrapper.set(vm, wrapper);
    }

    void beginDispatch(JSC::VM& vm)
    {
        if (!m_activeDispatchCount++ && m_onceWrapper)
            m_dispatchOnceWrapper.set(vm, m_onceWrapper.get());
    }

    void endDispatch()
    {
        ASSERT(m_activeDispatchCount);
        if (!--m_activeDispatchCount)
            m_dispatchOnceWrapper.clear();
    }

    template<typename Visitor> void visitJSFunctions(Visitor& visitor)
    {
        m_callback->visitJSFunction(visitor);
        // The registration owns its exposed wrapper, including when callers only hold a WeakRef.
        visitor.append(m_onceWrapper);
    }

private:
    SimpleRegisteredEventListener(Ref<EventListener>&& listener, bool once)
        : m_isOnce(once)
        , m_wasRemoved(false)
        , m_hasFired(false)
        , m_callback(WTF::move(listener))
    {
    }

    bool m_isOnce : 1;
    bool m_wasRemoved : 1;
    bool m_hasFired : 1;
    Ref<EventListener> m_callback;
    JSC::WriteBarrier<JSC::JSObject> m_onceWrapper;
    // A dispatch snapshot outlives map removal and must root wrappers exposed during callbacks.
    JSC::Strong<JSC::JSObject> m_dispatchOnceWrapper;
    unsigned m_activeDispatchCount { 0 };
};

using SimpleEventListenerVector = Vector<RefPtr<SimpleRegisteredEventListener>, 2, CrashOnOverflow, 6>;
using EntriesVector = Vector<std::pair<JSC::Identifier, SimpleEventListenerVector>, 4, CrashOnOverflow, 8>;

class SimpleEventListenerSnapshot {
public:
    // Reentrant JS can remove registrations or expose wrappers after this snapshot starts.
    SimpleEventListenerSnapshot(JSC::VM& vm, SimpleEventListenerVector&& listeners)
        : m_listeners(WTF::move(listeners))
    {
        for (auto& registration : m_listeners) {
            registration->beginDispatch(vm);
            if (auto* callback = registration->callback().jsFunction())
                m_callbacks.append(callback);
        }
    }

    ~SimpleEventListenerSnapshot()
    {
        for (auto& registration : m_listeners)
            registration->endDispatch();
    }

    const SimpleEventListenerVector& listeners() const { return m_listeners; }
    bool hasOverflowed() { return m_callbacks.hasOverflowed(); }

private:
    SimpleEventListenerVector m_listeners;
    JSC::MarkedArgumentBuffer m_callbacks;
};

class IdentifierEventListenerMap {
public:
    IdentifierEventListenerMap();

    bool isEmpty() const { return m_entries.isEmpty(); }
    bool contains(const JSC::Identifier& eventType) const { return find(eventType); }
    bool containsActive(const JSC::Identifier& eventType) const;

    const EntriesVector& entries() const { return m_entries; }

    void clear();

    bool add(const JSC::Identifier& eventType, Ref<EventListener>&&, bool once);
    bool prepend(const JSC::Identifier& eventType, Ref<EventListener>&&, bool once);
    bool remove(const JSC::Identifier& eventType, SimpleRegisteredEventListener&);
    bool removeAll(const JSC::Identifier& eventType);
    WEBCORE_EXPORT SimpleEventListenerVector* find(const JSC::Identifier& eventType);
    const SimpleEventListenerVector* find(const JSC::Identifier& eventType) const { return const_cast<IdentifierEventListenerMap*>(this)->find(eventType); }
    Vector<JSC::Identifier> eventTypes() const;
    template<typename Visitor> void visitJSEventListeners(Visitor&);

    Lock& lock() { return m_lock; }

private:
    EntriesVector m_entries;
    Lock m_lock;
};

template<typename Visitor>
void IdentifierEventListenerMap::visitJSEventListeners(Visitor& visitor)
{
    Locker locker { m_lock };
    for (auto& entry : m_entries) {
        for (auto& eventListener : entry.second)
            eventListener->visitJSFunctions(visitor);
    }
}

} // namespace WebCore
