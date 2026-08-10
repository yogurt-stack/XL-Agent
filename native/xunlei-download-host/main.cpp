#include <xl_dl/xl_dl_login_token.hpp>
#include <xl_dl/xl_dl_sdk.h>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

namespace {

std::mutex output_mutex;
std::atomic<bool> stopping(false);

std::string env_or_empty(const char* name) {
    const char* value = std::getenv(name);
    return value == nullptr ? std::string() : std::string(value);
}

void emit(const nlohmann::json& value) {
    std::lock_guard<std::mutex> lock(output_mutex);
    std::cout << value.dump() << std::endl;
}

void emit_error(const std::string& request_id, int code, const std::string& message) {
    emit({
        {"type", "error"},
        {"requestId", request_id},
        {"code", code},
        {"message", message}
    });
}

int init_sdk() {
    const std::string app_id = env_or_empty("XL_AGENT_XUNLEI_APP_ID");
    const std::string app_version = env_or_empty("XL_AGENT_XUNLEI_APP_VERSION");
    const std::string config_path = env_or_empty("XL_AGENT_XUNLEI_CONFIG_DIR");
    const std::string api_key = env_or_empty("XL_AGENT_XUNLEI_API_KEY");

    if (app_id.empty() || api_key.empty() || config_path.empty()) {
        emit({
            {"type", "error"},
            {"requestId", ""},
            {"code", -1},
            {"message", "迅雷 SDK 需要 XL_AGENT_XUNLEI_APP_ID、XL_AGENT_XUNLEI_API_KEY 和 XL_AGENT_XUNLEI_CONFIG_DIR。"}
        });
        return 1;
    }

    xl_dl_init_param params;
    std::memset(&params, 0, sizeof(params));
    params.app_id = app_id.c_str();
    params.app_version = app_version.empty() ? "1.0.0" : app_version.c_str();
    params.cfg_path = config_path.c_str();
    params.save_tasks = 1;

    const int init_code = xl_dl_init(&params);
    if (init_code != XL_DL_ERROR_SUCCESS && init_code != XL_DL_ERROR_ALREADY_INIT) {
        emit_error("", init_code, "xl_dl_init failed");
        return init_code;
    }

    const xl_dl::login_token_result token = xl_dl::get_login_token(api_key);
    if (token.code != 0 || token.token.empty()) {
        emit_error("", token.code, token.message.empty() ? "get_login_token failed" : token.message);
        xl_dl_uninit();
        return token.code == 0 ? 1 : token.code;
    }

    char session_id[XL_DL_MAX_SESSION_ID_LEN] = {0};
    const int login_code = xl_dl_login(token.token.c_str(), session_id);
    if (login_code != XL_DL_ERROR_SUCCESS) {
        emit_error("", login_code, "xl_dl_login failed");
        xl_dl_uninit();
        return login_code;
    }

    emit({{"type", "ready"}});
    return 0;
}

void run_download(const nlohmann::json& request) {
    const std::string request_id = request.value("requestId", "");
    const std::string url = request.value("url", "");
    const std::string save_path = request.value("savePath", "");
    const std::string save_name = request.value("saveName", "");
    if (request_id.empty() || url.empty() || save_path.empty() || save_name.empty()) {
        emit_error(request_id, XL_DL_ERROR_PARAM_ERROR, "download request is missing required fields");
        return;
    }

    xl_dl_create_p2sp_info info;
    std::memset(&info, 0, sizeof(info));
    info.url = url.c_str();
    info.save_path = save_path.c_str();
    info.save_name = save_name.c_str();

    uint64_t task_id = 0;
    int code = xl_dl_create_p2sp_task(&info, &task_id);
    if (code != XL_DL_ERROR_SUCCESS) {
        emit_error(request_id, code, "xl_dl_create_p2sp_task failed");
        return;
    }
    code = xl_dl_start_task(task_id);
    if (code != XL_DL_ERROR_SUCCESS) {
        emit_error(request_id, code, "xl_dl_start_task failed");
        return;
    }

    for (;;) {
        if (stopping.load()) {
            xl_dl_stop_task(task_id);
            emit({{"type", "cancelled"}, {"requestId", request_id}});
            return;
        }
        xl_dl_task_state state;
        std::memset(&state, 0, sizeof(state));
        code = xl_dl_get_task_state(task_id, &state);
        if (code != XL_DL_ERROR_SUCCESS) {
            emit_error(request_id, code, "xl_dl_get_task_state failed");
            return;
        }
        emit({
            {"type", "progress"},
            {"requestId", request_id},
            {"downloadedBytes", state.downloaded_size},
            {"totalBytes", state.total_size},
            {"speedBytesPerSecond", state.speed},
            {"stateCode", state.state_code},
            {"taskErrorCode", state.task_err_code}
        });
        if (state.state_code == XL_DL_TASK_STATUS_SUCCEEDED) {
            emit({
                {"type", "completed"},
                {"requestId", request_id},
                {"taskId", task_id},
                {"bytesWritten", state.downloaded_size}
            });
            return;
        }
        if (state.state_code == XL_DL_TASK_STATUS_FAILED) {
            emit_error(request_id, state.task_err_code, "迅雷下载任务失败");
            return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }
}

}  // namespace

int main() {
    if (init_sdk() != 0) return 1;

    std::string line;
    std::thread worker;
    std::atomic<bool> active(false);
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        try {
            const nlohmann::json request = nlohmann::json::parse(line);
            const std::string action = request.value("action", "");
            if (action == "download") {
                if (active.load()) {
                    emit_error(request.value("requestId", ""), XL_DL_ERROR_TOO_MUCH_TASK, "迅雷 SDK 宿主一次只处理一个下载任务");
                    continue;
                }
                if (worker.joinable()) worker.join();
                stopping.store(false);
                active.store(true);
                worker = std::thread([request, &active]() {
                    run_download(request);
                    active.store(false);
                });
            } else if (action == "cancel") {
                stopping.store(true);
            } else if (action == "shutdown") {
                stopping.store(true);
                if (worker.joinable()) worker.join();
                break;
            } else {
                emit_error(request.value("requestId", ""), XL_DL_ERROR_PARAM_ERROR, "unknown action");
            }
        } catch (const std::exception& error) {
            emit_error("", XL_DL_ERROR_PARAM_ERROR, error.what());
        }
    }

    stopping.store(true);
    if (worker.joinable()) worker.join();
    xl_dl_uninit();
    return 0;
}
