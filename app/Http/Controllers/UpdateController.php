<?php

namespace App\Http\Controllers;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\Process\Exception\ProcessFailedException;
use Symfony\Component\Process\Process;

class UpdateController extends Controller
{
    const SUCCESS = 0;
    const ERROR = 1;

    private $output = "";
    private $status = UpdateController::SUCCESS;

    /**
     * @param Request $request
     *
     * @return Application|ResponseFactory|Response
     */
    public function update(Request $request)
    {
        $this->output = "";
        $message      = "";

        try {
            $base_command = "cd ".base_path();

            $process = Process::fromShellCommandline("$base_command && git pull");
            $process->run();

            if (!$process->isSuccessful()) {
                $this->status = UpdateController::ERROR;
                $this->output = $process->getErrorOutput();
            }

        } catch (ProcessFailedException  $e) {
            $status  = UpdateController::ERROR;
            $message = $e->getMessage();
        }

        return response([
            "status"  => $this->status,
            "output"  => $this->output,
            "message" => $message
        ]);
    }
}
