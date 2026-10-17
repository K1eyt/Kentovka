// Запуск Node.js внутри приложения (nodejs-mobile): там работает та же программа, что на ПК —
// друзья, личка, группы, аккаунт, мосты. Вывод node идёт в журнал Android (logcat, тег kentovka-node).
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "node.h"

static int pfd[2];
static void *logger(void *) {
    char buf[1024]; ssize_t n;
    while ((n = read(pfd[0], buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(ANDROID_LOG_INFO, "kentovka-node", buf);
    }
    return nullptr;
}
static void start_logger() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pfd);
    dup2(pfd[1], 1);
    dup2(pfd[1], 2);
    pthread_t t;
    if (pthread_create(&t, nullptr, logger, nullptr) == 0) pthread_detach(t);
}

extern "C" JNIEXPORT jint JNICALL
Java_ru_kentovka_app_NodeHost_startNode(JNIEnv *env, jclass, jobjectArray args) {
    int argc = env->GetArrayLength(args);
    std::vector<std::string> v;
    size_t total = 0;
    for (int i = 0; i < argc; i++) {
        jstring s = (jstring) env->GetObjectArrayElement(args, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        v.emplace_back(c);
        total += strlen(c) + 1;
        env->ReleaseStringUTFChars(s, c);
    }
    // node требует, чтобы аргументы лежали в памяти подряд
    char *mem = (char *) calloc(total, 1);
    char **argv = (char **) calloc(argc + 1, sizeof(char *));
    char *p = mem;
    for (int i = 0; i < argc; i++) { argv[i] = p; strcpy(p, v[i].c_str()); p += v[i].size() + 1; }
    start_logger();
    return node::Start(argc, argv);
}
