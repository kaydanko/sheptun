var socket = io();
var clientSid = null;
var clientNickname = "";
var currentRoom = "common_room";
var currentChatType = "common";
var currentChatId = "common_room";
var privateChats = {}; // Store private chat data
var pendingPrivateChats = []; // Store pending private chat requests
var messageHistory = {}; // Store message history for each room
var historyLoaded = {}; // Track which rooms have history loaded

const messagesDiv = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const imageButton = document.getElementById("imageButton");
const imageInput = document.getElementById("imageInput");
const contextMenu = document.getElementById("contextMenu");
const hamburger = document.getElementById("toggleSidebar");
const sidebar = document.getElementById("sidebar");
const usersList = document.getElementById("users-list");
const userAliasElement = document.getElementById("user-alias");
const currentChatName = document.getElementById("current-chat-name");
const chatsSection = document.querySelector(".chats-section");
const backgroundButton = document.getElementById("backgroundButton");
const backgroundInput = document.getElementById("backgroundInput");
const chatContainer = document.getElementById("chat-container");
let currentMessageId = null;
let currentMessageElement = null;
let isEditingMessage = false;
let touchStartTime = null;
let touchTimeout = null;
const LONG_PRESS_DURATION = 500; // 500ms for long press

// Save message to history
function saveMessageToHistory(room, messageWrapper) {
    if (!messageHistory[room]) {
        messageHistory[room] = [];
    }
    const messageId = messageWrapper.querySelector('.message')?.dataset.id;
    if (messageId && !messageHistory[room].some(wrapper => wrapper.querySelector('.message')?.dataset.id === messageId)) {
        messageHistory[room].push(messageWrapper.cloneNode(true));
    }
}

// Load message history for room
function loadMessageHistory(room) {
    if (!messageHistory[room]) {
        messageHistory[room] = [];
    }

    // Always clear the messages div when loading history for a different room
    if (messagesDiv.dataset.currentRoom !== room) {
        messagesDiv.innerHTML = "";
        messagesDiv.dataset.currentRoom = room;
    }

    // If we already have messages displayed for this room, don't reload them
    if (messagesDiv.dataset.currentRoom === room && messagesDiv.children.length > 0 && messageHistory[room].length > 0) {
        // console.log(`Messages already displayed for ${room} - skipping reload`);
        return;
    }

    // Clear and load messages for the new room
    messagesDiv.innerHTML = "";
    messagesDiv.dataset.currentRoom = room;

    messageHistory[room].forEach(messageWrapper => {
        const clonedWrapper = messageWrapper.cloneNode(true);
        messagesDiv.appendChild(clonedWrapper);
    });

    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    // console.log(`Loaded history for room: ${room}`);
}

// Request chat history from server
function requestChatHistory(roomName, limit = 50) {
    // console.log(`Requesting chat history for room: ${roomName}, historyLoaded: ${historyLoaded[roomName]}`);

    // Завжди запитуємо історію з сервера при переключенні в кімнату
    socket.emit("get_chat_history", {
        room_name: roomName,
        limit: limit
    });
}

// Handle chat history response from server
socket.on("chat_history_response", (data) => {
    // console.log(`Received chat history for room: ${data.room_name}`, data);
    const roomName = data.room_name;

    historyLoaded[roomName] = true;
    if (!messageHistory[roomName]) {
        messageHistory[roomName] = [];
    }

    // Очищуємо існуючу історію для цієї кімнати
    messageHistory[roomName] = [];

    // Clear existing messages from DOM if this is the current room
    if (roomName === currentRoom) {
        messagesDiv.innerHTML = "";
        messagesDiv.dataset.currentRoom = roomName;
    }

    data.messages.forEach(msg => {
        const isOwnMessage = msg.sid === clientSid;

        const messageWrapper = document.createElement("div");
        messageWrapper.classList.add("message-wrapper");
        messageWrapper.classList.add(isOwnMessage ? "user" : "bot");

        const authorDiv = document.createElement("div");
        authorDiv.classList.add("message-author");
        authorDiv.classList.add(isOwnMessage ? "user" : "bot");

        const displayName = msg.nickname || msg.alias || msg.sid.slice(0, 8);
        authorDiv.textContent = displayName + (isOwnMessage ? " (you)" : "");
        messageWrapper.appendChild(authorDiv);

        const messageElement = document.createElement("div");
        messageElement.classList.add("message");
        messageElement.dataset.id = msg.id;
        messageElement.dataset.sid = msg.sid;
        messageElement.classList.add(isOwnMessage ? "user" : "bot");

        if (msg.type === "text") {
            messageElement.textContent = msg.data;
        } else if (msg.type === "image") {
            const img = document.createElement("img");
            img.src = msg.data;
            messageElement.appendChild(img);
        }

        messageElement.dataset.timestamp = msg.timestamp;
        messageWrapper.appendChild(messageElement);

        saveMessageToHistory(roomName, messageWrapper);

        // Add to DOM if this is the current room
        if (roomName === currentRoom) {
            messagesDiv.appendChild(messageWrapper);
        }
    });

    if (roomName === currentRoom) {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
});

// Handle incoming message
socket.on("message", (msg) => {
    // console.log(`Received new message for room: ${msg.room}, currentRoom: ${currentRoom}`);

    const isOwnMessage = msg.sid === clientSid;
    const messageId = msg.id;

    // Check if message already exists in history
    if (messageHistory[msg.room]?.some(wrapper => wrapper.querySelector('.message')?.dataset.id === messageId)) {
        // console.log(`Skipping duplicate message: ${messageId}`);
        return;
    }

    const messageWrapper = document.createElement("div");
    messageWrapper.classList.add("message-wrapper");
    messageWrapper.classList.add(isOwnMessage ? "user" : "bot");

    const authorDiv = document.createElement("div");
    authorDiv.classList.add("message-author");
    authorDiv.classList.add(isOwnMessage ? "user" : "bot");

    const displayName = msg.nickname || msg.alias || msg.sid.slice(0, 8);
    authorDiv.textContent = displayName + (isOwnMessage ? " (you)" : "");
    messageWrapper.appendChild(authorDiv);

    const messageElement = document.createElement("div");
    messageElement.classList.add("message");
    messageElement.dataset.id = msg.id;
    messageElement.dataset.sid = msg.sid;
    messageElement.classList.add(isOwnMessage ? "user" : "bot");

    if (msg.type === "text") {
        messageElement.textContent = msg.data;
    } else if (msg.type === "image") {
        const img = document.createElement("img");
        img.src = msg.data;
        messageElement.appendChild(img);
    }

    messageElement.dataset.timestamp = msg.timestamp;
    messageWrapper.appendChild(messageElement);

    saveMessageToHistory(msg.room, messageWrapper);

    if (msg.room === currentRoom) {
        messagesDiv.appendChild(messageWrapper);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    notifyIfPrivateMessage(msg);
});

// Chat switching functionality
function switchToChat(chatType, chatId, chatName, roomName = null) {
    // console.log(`Switching to chat: type=${chatType}, id=${chatId}, name=${chatName}, room=${roomName}`);

    let newRoom;
    if (chatType === "private") {
        if (roomName) {
            newRoom = roomName;
        } else if (chatId === clientSid) {
            newRoom = `private_room_${clientSid}_${clientSid}`;
        } else {
            if (typeof clientSid !== 'string' || typeof chatId !== 'string') {
                console.error(`Invalid SIDs: clientSid=${clientSid}, chatId=${chatId}`);
                return;
            }
            newRoom = `private_room_${Math.min(clientSid, chatId)}_${Math.max(clientSid, chatId)}`;
        }
    } else {
        newRoom = "common_room";
    }

    // Ensure messageHistory and historyLoaded are initialized for the new room
    if (!messageHistory[newRoom]) {
        messageHistory[newRoom] = [];
    }
    if (!historyLoaded[newRoom]) {
        historyLoaded[newRoom] = false;
    }

    // Check if we're already in this exact chat and room
    if (chatType === currentChatType && chatId === currentChatId && newRoom === currentRoom) {
        // console.log(`Already in chat: ${chatName}, skipping switch`);
        return;
    }

    if (chatType === "private" && (!clientSid || !chatId)) {
        console.warn(`Cannot switch to private chat: clientSid=${clientSid}, chatId=${chatId}`);
        pendingPrivateChats.push({ chatType, chatId, chatName, roomName });
        return;
    }

    const previousRoom = currentRoom;
    const previousChatType = currentChatType;
    const previousChatId = currentChatId;

    // Update current chat info
    currentChatType = chatType;
    currentChatId = chatId;
    currentRoom = newRoom;

    currentChatName.textContent = chatName;

    // Update UI active states
    document.querySelectorAll(".chat-item").forEach((item) => {
        item.classList.remove("active");
    });

    const targetChatElement = document.querySelector(`[data-chat-id="${chatId}"]`);
    if (targetChatElement) {
        targetChatElement.classList.add("active");
    }

    const isRoomChange = currentRoom !== previousRoom;
    const isChatChange = currentChatType !== previousChatType || currentChatId !== previousChatId;

    // console.log(`Room change: ${isRoomChange}, Chat change: ${isChatChange}, Previous: ${previousRoom}, Current: ${currentRoom}`);

    // Always clear messages when switching to a different chat/room
    if (isRoomChange || isChatChange) {
        // console.log(`Clearing messages div for room switch from ${previousRoom} to ${currentRoom}`);
        messagesDiv.innerHTML = "";
        messagesDiv.dataset.currentRoom = currentRoom;

        // Join the appropriate room on server
        if (chatType === "common" && currentRoom !== previousRoom) {
            socket.emit("join_common_room");
        } else if (chatType === "private" && currentRoom !== previousRoom) {
            socket.emit("join_private_chat", { target_sid: chatId });
        }

        // Скидаємо флаг завантаженої історії для повторного запиту
        historyLoaded[newRoom] = false;

        // Request history for the new room
        // console.log(`Requesting history for room: ${currentRoom}`);
        requestChatHistory(currentRoom, 50);
    }

    if (window.innerWidth <= 767) {
        sidebar.classList.remove("open");
    }
}

// Handle private chat joined
socket.on("private_chat_joined", (data) => {
    // console.log("Private chat joined:", data);
    privateChats[data.room_name] = true;
    currentChatName.textContent = data.target_name;

    if (!messageHistory[data.room_name]) {
        messageHistory[data.room_name] = [];
    }
    if (!historyLoaded[data.room_name]) {
        historyLoaded[data.room_name] = false;
    }

    if (currentRoom !== data.room_name) {
        currentRoom = data.room_name;
        // Clear messages when switching to new room
        messagesDiv.innerHTML = "";
        messagesDiv.dataset.currentRoom = currentRoom;
        // console.log(`Requesting history for private room: ${currentRoom}`);
        requestChatHistory(currentRoom, 50);
    } else {
        // console.log(`Already in private room: ${currentRoom}, loading existing history`);
        loadMessageHistory(currentRoom);
    }
});

// Load and apply background image from localStorage on page load
function loadBackgroundImage() {
    const savedBackground = localStorage.getItem("chatBackground");
    if (savedBackground) {
        chatContainer.style.backgroundImage = `url(${savedBackground})`;
        chatContainer.style.backgroundSize = "cover";
        chatContainer.style.backgroundPosition = "center";
        chatContainer.style.backgroundRepeat = "no-repeat";
    }
}

// Handle background image upload
backgroundButton.addEventListener("click", () => {
    backgroundInput.click();
});

backgroundInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
        // Check file size (5MB limit = 5 * 1024 * 1024 bytes)
        if (file.size > 5 * 1024 * 1024) {
            alert("Error: Background image size exceeds 5MB limit. Please choose a smaller file.");
            e.target.value = "";
            return;
        }
        const reader = new FileReader();
        reader.onload = (event) => {
            const imageData = event.target.result;
            localStorage.setItem("chatBackground", imageData);
            chatContainer.style.backgroundImage = `url(${imageData})`;
            chatContainer.style.backgroundSize = "cover";
            chatContainer.style.backgroundPosition = "center";
            chatContainer.style.backgroundRepeat = "no-repeat";
        };
        reader.readAsDataURL(file);
        e.target.value = "";
    }
});

// Add private chat to sidebar
function addPrivateChatToSidebar(targetSid, targetName) {
    if (!targetSid || typeof targetSid !== 'string') {
        console.warn(`Invalid targetSid: ${targetSid}`);
        return;
    }

    const chatId = targetSid;

    if (document.querySelector(`[data-chat-id="${chatId}"]`)) {
        return;
    }

    const chatItem = document.createElement("div");
    chatItem.classList.add("chat-item");
    chatItem.dataset.chatType = "private";
    chatItem.dataset.chatId = chatId;

    const chatName = document.createElement("div");
    chatName.classList.add("chat-name");
    chatName.textContent = targetName;

    chatItem.appendChild(chatName);

    chatItem.addEventListener("click", () => {
        switchToChat("private", chatId, targetName);
        // Закриття сайдбару на маленькому екрані
        if (window.innerWidth <= 767) {
            sidebar.classList.remove("open");
        }
    });

    const commonRoom = document.querySelector('[data-chat-type="common"]');
    commonRoom.parentNode.insertBefore(chatItem, commonRoom.nextSibling);
}

socket.on("connect", function () {
    clientSid = socket.id;
    const userAlias = document.getElementById("user-alias");
    userAlias.textContent = clientSid.slice(0, 8);
    // console.log(`Connected with SID: ${clientSid}`);

    // Initialize history for common room and personal chat
    if (!messageHistory["common_room"]) {
        messageHistory["common_room"] = [];
    }
    if (!historyLoaded["common_room"]) {
        historyLoaded["common_room"] = false;
    }
    const personalRoom = `private_room_${clientSid}_${clientSid}`;
    if (!messageHistory[personalRoom]) {
        messageHistory[personalRoom] = [];
    }
    if (!historyLoaded[personalRoom]) {
        historyLoaded[personalRoom] = false;
    }

    loadBackgroundImage();
    requestChatHistory("common_room", 50);

    while (pendingPrivateChats.length > 0) {
        const { chatType, chatId, chatName, roomName } = pendingPrivateChats.shift();
        switchToChat(chatType, chatId, chatName, roomName);
    }

    userAliasElement.addEventListener("click", function () {
        // console.log("New nickname addEventListener");
        if (!this.classList.contains("editing")) {
            const originalText = this.textContent;
            this.contentEditable = true;
            this.classList.add("editing");
            this.focus();

            const range = document.createRange();
            range.selectNodeContents(this);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);

            let isSaved = false;

            const saveNickname = (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    let newNickname = this.textContent.trim();
                    // console.log("New nickname:", newNickname);

                    if (newNickname.length > 12) {
                        newNickname = newNickname.slice(0, 12);
                    }

                    clientNickname = newNickname;
                    socket.emit("set_nickname", { nickname: newNickname });
                    this.contentEditable = false;
                    this.classList.remove("editing");
                    isSaved = true;

                    this.textContent = newNickname || clientSid.slice(0, 8);
                }
            };

            const handleBlur = () => {
                if (!isSaved) {
                    this.textContent = originalText;
                }
                this.contentEditable = false;
                this.classList.remove("editing");
                this.removeEventListener("keypress", saveNickname);
            };

            this.addEventListener("keypress", saveNickname);
            this.addEventListener("blur", handleBlur, { once: true });
        }
    });
});

document
    .querySelector('[data-chat-type="common"]')
    .addEventListener("click", () => {
        switchToChat("common", "common_room", "Hello, this is a free anonymous unencrypted chat without restrictions for everyone");
        // Закриття сайдбару на маленькому екрані
        if (window.innerWidth <= 767) {
            sidebar.classList.remove("open");
        }
    });

socket.on("users_update", function (data) {
    usersList.innerHTML = "";
    data.users.forEach((user) => {
        const userItem = document.createElement("div");
        userItem.classList.add("user-item");
        userItem.style.cursor = "pointer";

        const statusDot = document.createElement("div");
        statusDot.classList.add("user-status");

        const userAlias = document.createElement("div");
        userAlias.classList.add("user-alias");

        let displayName = user.nickname || user.alias;
        userAlias.textContent = displayName;

        if (user.sid === clientSid) {
            userAlias.classList.add("current-user");
            userAlias.textContent += " (you)";

            userItem.addEventListener("click", () => {
                const personalChatName = `${displayName} (Personal Time)`;
                addPrivateChatToSidebar(user.sid, personalChatName);
                switchToChat("private", user.sid, personalChatName);
                // Закриття сайдбару на маленькому екрані
                if (window.innerWidth <= 767) {
                    sidebar.classList.remove("open");
                }
            });
        } else {
            userItem.addEventListener("click", () => {
                const targetName = user.nickname || user.alias;
                addPrivateChatToSidebar(user.sid, targetName);
                switchToChat("private", user.sid, targetName);
                // Закриття сайдбару на маленькому екрані
                if (window.innerWidth <= 767) {
                    sidebar.classList.remove("open");
                }
            });
        }

        userItem.appendChild(statusDot);
        userItem.appendChild(userAlias);
        usersList.appendChild(userItem);
    });
});

socket.on("error", (data) => {
    console.error("Server error:", data.message);
    alert(data.message);
});

socket.on("private_chat_invitation", (data) => {
    // console.log("Private chat invitation received:", data);
    addPrivateChatToSidebar(data.initiator_sid, data.initiator_name);
    if (!privateChats[data.room_name]) {
        switchToChat("private", data.initiator_sid, data.initiator_name, data.room_name);
    }
});

function sendMessage() {
    const message = messageInput.value;
    if (message) {
        // console.log(`Sending message to room: ${currentRoom}`);
        socket.emit("message", {
            data: message,
            type: "text",
            timestamp: new Date().toISOString(),
            room: currentRoom,
        });
        messageInput.value = "";
        messageInput.style.height = "calc(1.4em + 20px)";
    }
}

imageButton.addEventListener("click", () => {
    imageInput.click();
});

imageInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
        // Check file size (5MB limit = 2 * 1024 * 1024 bytes)
        if (file.size > 25 * 1024 * 1024) {
            alert("Error: Image size exceeds 25MB limit. Please choose a smaller file.");
            e.target.value = "";
            return;
        }
        const reader = new FileReader();
        reader.onload = (event) => {
            // console.log(`Sending image to room: ${currentRoom}`);
            socket.emit("message", {
                data: event.target.result,
                type: "image",
                timestamp: new Date().toISOString(),
                room: currentRoom,
            });
        };
        reader.readAsDataURL(file);
        e.target.value = "";
    }
});

messageInput.addEventListener("input", function () {
    const textarea = this;
    textarea.style.height = "calc(1.4em + 20px)";
    const scrollHeight = textarea.scrollHeight;
    const maxHeight = parseFloat(getComputedStyle(textarea).maxHeight);
    textarea.style.height = Math.min(scrollHeight, maxHeight) + "px";
});

hamburger.addEventListener("click", function () {
    sidebar.classList.toggle("open");
});

socket.on("message_edited", (data) => {
    const messageElement = document.querySelector(
        `.message[data-id="${data.id}"]`
    );
    if (messageElement) {
        if (!messageElement.querySelector("img")) {
            messageElement.textContent = data.data;

            Object.keys(messageHistory).forEach(room => {
                if (messageHistory[room]) {
                    messageHistory[room].forEach(wrapper => {
                        const msg = wrapper.querySelector(`.message[data-id="${data.id}"]`);
                        if (msg && !msg.querySelector("img")) {
                            msg.textContent = data.data;
                        }
                    });
                }
            });
        }
    }
});

socket.on("message_deleted", (data) => {
    const messageWrapper = document.querySelector(
        `.message[data-id="${data.id}"]`
    )?.parentElement;
    if (messageWrapper) {
        messageWrapper.remove();

        Object.keys(messageHistory).forEach(room => {
            if (messageHistory[room]) {
                messageHistory[room] = messageHistory[room].filter(wrapper => {
                    const msg = wrapper.querySelector(`.message[data-id="${data.id}"]`);
                    return !msg;
                });
            }
        });
    }
});

function showContextMenu(messageElement, x, y) {
    currentMessageId = messageElement.dataset.id;
    currentMessageElement = messageElement;
    const isOwnMessage = messageElement.dataset.sid === clientSid;
    const isImage = messageElement.querySelector("img") !== null;

    document.querySelector(".context-edit").style.display =
        isOwnMessage && !isImage ? "block" : "none";
    document.querySelector(".context-delete").style.display = isOwnMessage
        ? "block" : "none";
    document.querySelector(".context-copy").style.display = !isImage
        ? "block" : "none";
    document.querySelector(".context-quote").style.display =
        !isOwnMessage && !isImage ? "block" : "none";

    contextMenu.style.display = "block";
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
}

messagesDiv.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const messageElement = e.target.closest(".message");
    if (messageElement) {
        showContextMenu(messageElement, e.pageX, e.pageY);
    }
});

messagesDiv.addEventListener("touchstart", (e) => {
    const messageElement = e.target.closest(").message");
    if (messageElement) {
        e.preventDefault();
        touchStartTime = Date.now();
        const touch = e.touches[0];
        touchTimeout = setTimeout(() => {
            showContextMenu(messageElement, touch.pageX, touch.pageY);
        }, LONG_PRESS_DURATION);
    }
});

messagesDiv.addEventListener("touchend", (e) => {
    clearTimeout(touchTimeout);
    touchStartTime = null;
});

messagesDiv.addEventListener("touchmove", (e) => {
    clearTimeout(touchTimeout);
    touchStartTime = null;
});

document.addEventListener("click", () => {
    contextMenu.style.display = "none";
});

document.querySelector(".context-edit").addEventListener("click", () => {
    if (currentMessageElement) {
        const originalText = currentMessageElement.textContent;
        currentMessageElement.contentEditable = true;
        currentMessageElement.focus();
        isEditingMessage = true;
        let isSaved = false;

        const saveEdit = function handler(e) {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                const newText = currentMessageElement.textContent;
                if (newText) {
                    socket.emit("edit_message", {
                        id: currentMessageId,
                        data: newText,
                    });
                    isSaved = true;
                }
                currentMessageElement.contentEditable = false;
                currentMessageElement.removeEventListener("keypress", handler);
                isEditingMessage = false;
            }
        };

        currentMessageElement.addEventListener("keypress", saveEdit);

        currentMessageElement.addEventListener(
            "blur",
            function handler() {
                if (!isSaved) {
                    currentMessageElement.textContent = originalText;
                }
                currentMessageElement.contentEditable = false;
                currentMessageElement.removeEventListener("keypress", saveEdit);
                isEditingMessage = false;
                this.removeEventListener("blur", handler);
            },
            { once: true }
        );
    }
});

document.querySelector(".context-copy").addEventListener("click", () => {
    if (currentMessageElement) {
        navigator.clipboard.writeText(currentMessageElement.textContent);
    }
});

document
    .querySelector(".context-delete")
    .addEventListener("click", () => {
        if (currentMessageId) {
            socket.emit("delete_message", { id: currentMessageId });
        }
    });

document.querySelector(".context-quote").addEventListener("click", () => {
    if (currentMessageElement) {
        messageInput.value = `> ${currentMessageElement.textContent}\n`;
        messageInput.focus();
        messageInput.dispatchEvent(new Event("input"));
    }
});

socket.on("nickname_updated", function ({ sid, nickname }) {
    document
        .querySelectorAll(`.message[data-sid="${sid}"]`)
        .forEach((msgElement) => {
            const wrapper = msgElement.closest(".message-wrapper");
            if (wrapper) {
                const author = wrapper.querySelector(".message-author");
                if (author) {
                    author.textContent =
                        (nickname) + (sid === clientSid ? " (you)" : "");
                }
            }
        });

    document
        .querySelectorAll(`[data-chat-id="${sid}"] .chat-name`)
        .forEach((chatName) => {
            if (sid === clientSid) {
                chatName.textContent = `${nickname} (Personal Time)`;
            } else {
                chatName.textContent = nickname || sid.slice(0, 8);
            }
        });

    Object.keys(messageHistory).forEach(room => {
        if (messageHistory[room]) {
            messageHistory[room].forEach(wrapper => {
                const msgs = wrapper.querySelectorAll(`.message[data-sid="${sid}"]`);
                forEach(msgElement => {
                    const author = wrapper.querySelector(".message-author");
                    if (author) {
                        author.textContent = nickname + (sid === clientSid ? " (you)" : "");
                    }
                });
            });
        }
    });
});

sendButton.addEventListener("click", () => {
    // console.log("Send button clicked");
    sendMessage();
});

document.addEventListener("keydown", function (event) {
    const isEditingNickname =
        userAliasElement.classList.contains("editing");

    if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.defaultPrevented &&
        !isEditingMessage &&
        !isEditingNickname
    ) {
        event.preventDefault();
        if (document.activeElement === messageInput) {
            sendMessage();
        } else {
            messageInput.focus();
        }
    }
});