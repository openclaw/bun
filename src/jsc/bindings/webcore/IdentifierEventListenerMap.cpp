#include "config.h"
#include "IdentifierEventListenerMap.h"

#include "Event.h"
#include "EventTarget.h"
#include "JSEventListener.h"
#include <wtf/MainThread.h>
#include <wtf/StdLibExtras.h>
#include <wtf/Vector.h>

namespace WebCore {

IdentifierEventListenerMap::IdentifierEventListenerMap() = default;

bool IdentifierEventListenerMap::containsActive(const JSC::Identifier& eventType) const
{
    return false;
}

void IdentifierEventListenerMap::clear()
{
    Locker locker { m_lock };

    for (auto& entry : m_entries) {
        for (auto& listener : entry.second)
            listener->markAsRemoved();
    }

    m_entries.clear();
}

Vector<JSC::Identifier> IdentifierEventListenerMap::eventTypes() const
{
    return m_entries.map([](auto& entry) {
        return entry.first;
    });
}

bool IdentifierEventListenerMap::add(const JSC::Identifier& eventType, Ref<EventListener>&& listener, bool once)
{
    Locker locker { m_lock };

    if (auto* listeners = find(eventType)) {
        listeners->append(SimpleRegisteredEventListener::create(WTF::move(listener), once));
        return true;
    }

    m_entries.append({ eventType, SimpleEventListenerVector { SimpleRegisteredEventListener::create(WTF::move(listener), once) } });
    return true;
}

bool IdentifierEventListenerMap::prepend(const JSC::Identifier& eventType, Ref<EventListener>&& listener, bool once)
{
    Locker locker { m_lock };

    if (auto* listeners = find(eventType)) {
        listeners->insert(0, SimpleRegisteredEventListener::create(WTF::move(listener), once));
        return true;
    }

    m_entries.append({ eventType, SimpleEventListenerVector { SimpleRegisteredEventListener::create(WTF::move(listener), once) } });
    return true;
}

bool IdentifierEventListenerMap::remove(const JSC::Identifier& eventType, SimpleRegisteredEventListener& registration)
{
    Locker locker { m_lock };
    for (size_t i = 0; i < m_entries.size(); ++i) {
        if (m_entries[i].first != eventType)
            continue;
        auto& listeners = m_entries[i].second;
        for (size_t j = listeners.size(); j--;) {
            if (listeners[j].get() != &registration)
                continue;
            listeners[j]->markAsRemoved();
            listeners.removeAt(j);
            if (listeners.isEmpty())
                m_entries.removeAt(i);
            return true;
        }
        return false;
    }
    return false;
}

bool IdentifierEventListenerMap::removeAll(const JSC::Identifier& eventType)
{
    Locker locker { m_lock };

    for (unsigned i = 0; i < m_entries.size(); ++i) {
        if (m_entries[i].first == eventType) {
            m_entries.removeAt(i);
            return true;
        }
    }

    return false;
}

SimpleEventListenerVector* IdentifierEventListenerMap::find(const JSC::Identifier& eventType)
{
    for (auto& entry : m_entries) {
        if (entry.first == eventType)
            return &entry.second;
    }

    return nullptr;
}

} // namespace WebCore
